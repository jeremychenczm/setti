import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb, testDatabaseUrl } from "../db/testing";

const migration = readFileSync("drizzle/0027_service_capture_refunds.sql", "utf8");
const recovery = migration.match(/DO \$legacy_saved_holds\$[\s\S]*?\$legacy_saved_holds\$;/)?.[0];

describe.skipIf(!testDatabaseUrl)("one-time recovery of legacy saved-PayPal approval orders", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  beforeAll(async () => { handle = await openTestDb(); });
  afterAll(() => handle?.pool.end());

  it("recovers only the mistaken failures, blocks ambiguous attempts and restores the final-state trigger", async () => {
    expect(recovery).toBeDefined();
    await handle.db.transaction(async (tx) => {
      // Temporary fixtures shadow the real tables only on this transaction's
      // connection. No project data or public trigger is changed by this test.
      await tx.execute(sql`
        CREATE TEMP TABLE payment_operations (
          id text PRIMARY KEY, project_id text NOT NULL DEFAULT 'project',
          item_id text, kind text NOT NULL DEFAULT 'authorize',
          saved_method_id text DEFAULT 'saved-paypal', status text NOT NULL DEFAULT 'failed',
          failure_code text DEFAULT 'SAVED_PAYPAL_NEEDS_CLIENT', failure_message text DEFAULT 'old failure',
          paypal_order_id text, paypal_resource_id text, authorization_id text, capture_id text,
          services_hold boolean NOT NULL DEFAULT false, request_id text NOT NULL DEFAULT 'original-request',
          amount_cents integer NOT NULL DEFAULT 10000, content_hash text NOT NULL DEFAULT 'original-hash',
          created_at timestamptz NOT NULL DEFAULT '2026-10-20 00:00:00Z',
          updated_at timestamptz NOT NULL DEFAULT '2026-10-20 00:00:00Z'
        ) ON COMMIT DROP;
        CREATE TEMP TABLE paypal_authorizations (operation_id text, paypal_order_id text) ON COMMIT DROP;
        INSERT INTO payment_operations (id, item_id, paypal_order_id) VALUES
          ('isolated', 'item-isolated', 'ORDER-ISOLATED'),
          ('pair-a', 'item-pair', 'ORDER-PAIR-A'), ('pair-b', 'item-pair', 'ORDER-PAIR-B'),
          ('older', 'item-later-open', 'ORDER-OLDER'), ('later-open', 'item-later-open', 'ORDER-LATER'),
          ('authorized', 'item-authorized', 'ORDER-AUTHORIZED'),
          ('other-failure', 'item-other', 'ORDER-OTHER'),
          ('no-order', 'item-no-order', null), ('known-resource', 'item-resource', 'ORDER-RESOURCE'),
          ('succeeded', 'item-succeeded', 'ORDER-SUCCEEDED'),
          ('checkout', 'item-checkout', 'ORDER-CHECKOUT');
        UPDATE payment_operations SET created_at = '2026-10-21 00:00:00Z' WHERE id IN ('pair-b', 'later-open');
        UPDATE payment_operations SET status = 'pending', failure_code = null WHERE id = 'later-open';
        UPDATE payment_operations SET failure_code = 'AUTHORIZATION_DENIED' WHERE id = 'other-failure';
        UPDATE payment_operations SET paypal_resource_id = 'AUTH-KNOWN' WHERE id = 'known-resource';
        UPDATE payment_operations SET status = 'succeeded', failure_code = null WHERE id = 'succeeded';
        UPDATE payment_operations SET saved_method_id = null WHERE id = 'checkout';
        INSERT INTO paypal_authorizations VALUES ('authorized', 'ORDER-AUTHORIZED');
        CREATE FUNCTION pg_temp.legacy_final_state_guard() RETURNS trigger AS $guard$
        BEGIN
          IF OLD.status IN ('succeeded', 'failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'its outcome is final';
          END IF;
          RETURN NEW;
        END
        $guard$ LANGUAGE plpgsql;
        CREATE TRIGGER payment_operations_forward BEFORE UPDATE ON payment_operations
          FOR EACH ROW EXECUTE FUNCTION pg_temp.legacy_final_state_guard();
      `);
      type Row = { id: string; status: string; failure_code: string | null; failure_message: string; updated_at: Date; [key: string]: unknown };
      const before = (await tx.execute<Row>(sql`SELECT * FROM payment_operations ORDER BY id`)).rows;
      await tx.execute(sql.raw(recovery!));
      const after = (await tx.execute<Row>(sql`SELECT * FROM payment_operations ORDER BY id`)).rows;
      const byId = new Map(after.map((row) => [row.id, row]));
      expect(byId.get("isolated")).toMatchObject({ status: "unknown", failure_code: "SAVED_PAYPAL_NEEDS_CHECK" });
      for (const id of ["pair-a", "pair-b", "older"]) {
        expect(byId.get(id)).toMatchObject({ status: "unknown", failure_code: "LEGACY_SAVED_PAYPAL_REVIEW_REQUIRED" });
      }
      const repaired = new Set(["isolated", "pair-a", "pair-b", "older"]);
      for (const row of before) {
        if (!repaired.has(row.id)) expect(byId.get(row.id)).toEqual(row);
        else {
          const identity = Object.fromEntries(Object.entries(row).filter(([field]) => !["status", "failure_code", "failure_message", "updated_at"].includes(field)));
          expect(byId.get(row.id)).toMatchObject(identity);
        }
      }
      expect((await tx.execute<{ enabled: string }>(sql`
        SELECT tgenabled AS enabled FROM pg_trigger
        WHERE tgrelid = 'pg_temp.payment_operations'::regclass AND tgname = 'payment_operations_forward'
      `)).rows).toEqual([{ enabled: "O" }]);
      await tx.execute(sql`SAVEPOINT final_state_guard`);
      await expect(tx.execute(sql`UPDATE payment_operations SET status = 'unknown' WHERE id = 'succeeded'`)).rejects.toThrow();
      await tx.execute(sql`ROLLBACK TO SAVEPOINT final_state_guard`);
    });
  });
});
