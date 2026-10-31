/** One scoped Sandbox service payment; no AI calls or furniture transactions. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { inArray } from "drizzle-orm";
import { accountOrDefault } from "../src/accounts/demo";
import { createDb } from "../src/db/client";
import { paypalCalls } from "../src/db/schema";
import { sandboxPayPal, sandboxTestCard } from "../src/payments/server";
import { servicesPaymentView } from "../src/payments/services-view";
import { ensureHomeWorkspace } from "../src/try/home";
import { prepareHomeServices } from "../src/try/home-payments";

async function main() {
  process.loadEnvFile(".env.local");
  const directory = "probes/recorded";
  await mkdir(directory, { recursive: true });
  // A rerun on the same day resumes the recorded session instead of starting another payment.
  const record = `${directory}/home-service-payment-${new Date().toISOString().slice(0, 10)}.json`;
  const previous = await readFile(record, "utf8").then((text) => JSON.parse(text) as { session: string }).catch(() => null);
  const session = previous?.session ?? randomUUID();
  await writeFile(record, JSON.stringify({ session, status: "started" }, null, 2));
  const { db, pool } = createDb();
  try {
    await ensureHomeWorkspace(db, session);
    const deps = { db, perHour: 1, paypal: sandboxPayPal(), testCard: sandboxTestCard(), links: (id: string) => ({ returnUrl: `http://localhost:3002/api/payments/paypal/return?op=${id}`, cancelUrl: `http://localhost:3002/api/payments/paypal/cancel?op=${id}` }) };
    const ids = await prepareHomeServices(deps, session);
    const view = await servicesPaymentView(db, session, "maple", accountOrDefault("emma"), null);
    assert.equal(view.basis?.version, 1);
    assert.equal(view.dueCents, 0);
    assert.equal(view.services[0]?.capturedCents, 100_000);
    assert.equal(view.savedPayPal, false, "Preparing a test-card fee must not invent a saved wallet");
    const calls = () => db.select({ step: paypalCalls.step, outcome: paypalCalls.outcome, httpStatus: paypalCalls.httpStatus }).from(paypalCalls).where(inArray(paypalCalls.operationId, ids));
    const before = await calls();
    assert.deepEqual(await prepareHomeServices(deps, session), ids);
    assert.equal((await calls()).length, before.length, "A retry must not make another provider call");
    await writeFile(record, JSON.stringify({ session, status: "passed", checkedAt: new Date().toISOString(), ids, view, calls: before, retryCreatedProviderCalls: 0 }, null, 2));
    console.log("Sandbox V1 service fee: $1,000 captured; retry made no additional provider calls; no wallet invented.");
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Service payment check failed."); process.exitCode = 1; });
