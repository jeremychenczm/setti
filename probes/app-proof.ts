/**
 * App-level Sandbox proof. Runs the mixed-change scenario through the app's own
 * code against the real PayPal Sandbox and an isolated proof database, then
 * reads every PayPal resource back and writes an evidence folder.
 *
 *   npm run sandbox:proof -- [--drop-refund-response] [--out evidence]
 *
 * The sandbox buyer approves three authorizations on PayPal; the runner prints
 * each link and waits until PayPal reports the order approved. The proof
 * database is emptied at the start; it must be named *_proof.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createDb } from "../src/db/client";
import { sandboxPayPal } from "../src/payments/server";
import { collectEvidence, sourceFingerprint, writeEvidence } from "../src/proof/evidence";
import { runMixedChangeProof } from "../src/proof/scenario";
import { arg, flag, run, waitForApproval } from "./lib/cli";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

/** The proof database: SETTI_PROOF_DATABASE_URL, or DATABASE_URL's server with database setti_proof. */
function proofDatabaseUrl(): URL {
  const configured = process.env.SETTI_PROOF_DATABASE_URL?.trim();
  const base = configured || process.env.DATABASE_URL?.trim();
  if (!base) throw new Error("Set SETTI_PROOF_DATABASE_URL or DATABASE_URL (see .env.example).");
  const url = new URL(base);
  if (!configured) url.pathname = "/setti_proof";
  if (!url.pathname.endsWith("_proof")) throw new Error(`The proof database must be named *_proof; refusing to empty ${url.pathname.slice(1)}.`);
  return url;
}

async function prepareDatabase(url: URL) {
  const name = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!exists.rowCount) await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  } finally {
    await client.end();
  }
  const handle = createDb(url.toString());
  await migrate(handle.db, { migrationsFolder: "drizzle" });
  await handle.pool.query('TRUNCATE "projects", "chat_cases" RESTART IDENTITY CASCADE');
  return handle;
}

run(async () => {
  const paypal = sandboxPayPal();
  const url = proofDatabaseUrl();
  const dropRefundResponse = flag("drop-refund-response");
  const { db, pool } = await prepareDatabase(url);
  try {
    console.log(`Proof database ${url.pathname.slice(1)} is ready. PayPal: Sandbox only.`);
    const proof = await runMixedChangeProof({
      db, paypal, dropRefundResponse,
      links: (operationId) => ({ returnUrl: `https://example.com/setti-proof/return?op=${operationId}`, cancelUrl: `https://example.com/setti-proof/cancel?op=${operationId}` }),
      approve: (approvalUrl, paypalOrderId, label) => waitForApproval(
        `${label}: open this link and approve as the sandbox buyer (Personal account). PayPal then shows example.com, which you can close.\n${approvalUrl}`,
        async () => {
          const order = await paypal.getOrder(paypalOrderId);
          if (order.kind === "ok" && (order.value.status === "VOIDED" || order.value.status === "COMPLETED")) throw new Error(`Order ${paypalOrderId} is ${order.value.status}`);
          return order.kind === "ok" && order.value.status === "APPROVED";
        },
        { timeoutMs: 15 * 60_000 },
      ),
      log: (message) => console.log(`- ${message}`),
    });
    const evidence = await collectEvidence(db, paypal, proof, await sourceFingerprint(process.cwd()));
    const directory = path.join(arg("out", "evidence"), `${evidence.generatedAt.slice(0, 10)}-mixed-change${dropRefundResponse ? "-lost-refund-answer" : ""}`);
    await writeEvidence(directory, evidence);
    const failed = evidence.checks.filter((check) => !check.ok);
    console.log(`\nEvidence written to ${directory}`);
    console.log(failed.length ? `${failed.length} of ${evidence.checks.length} checks failed:\n${failed.map((check) => `  - ${check.name}: ${check.detail}`).join("\n")}` : `All ${evidence.checks.length} checks passed.`);
    if (failed.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
});
