import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { FakePayPal } from "../payments/testing/fake-paypal";
import { links } from "../payments/testing/flows";
import { collectEvidence, evidenceReadme, sourceFingerprint, writeEvidence } from "./evidence";
import { runMixedChangeProof } from "./scenario";

describe.skipIf(!testDatabaseUrl)("Sandbox proof runner on the fake PayPal", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    paypal = new FakePayPal();
  });
  afterAll(() => handle?.pool.end());

  const run = (dropRefundResponse = false) => runMixedChangeProof({
    db: handle.db, paypal, links, dropRefundResponse,
    approve: async (_url, paypalOrderId) => paypal.approve(paypalOrderId),
  });
  const source = { commit: "0123456789abcdef", dirty: false, files: [{ path: "src/payments/refund.ts", sha256: "0".repeat(64) }] };

  it("runs one change through release, capture and refund, and every PayPal read matches the ledger", async () => {
    const proof = await run(true);
    expect(proof.steps.map((step) => step.label)).toEqual([
      "Authorize the lounge chair ($800.00)", "Authorize the wool rug ($300.00)", "Capture the rug after supplier confirmation",
      "Release the lounge chair hold", "Authorize the writing desk ($1,100.00)", "Capture the desk after supplier confirmation",
      "Refund the rug minus the restocking fee", "Check the refund whose answer was lost",
    ]);
    const evidence = await collectEvidence(handle.db, paypal, proof, source, new Date("2026-10-22T08:00:00Z"));
    expect(evidence.checks.filter((check) => !check.ok)).toEqual([]);
    expect(evidence.passed).toBe(true);
    expect(evidence.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "A refund whose answer was lost is recovered without a second refund",
      "Lounge chair hold released, nothing charged", "Writing desk captured in full", "Rug refunded except the $60 restocking fee",
    ]));
    expect(evidence.provider.map((entry) => entry.kind).sort()).toEqual(["authorization", "authorization", "authorization", "capture", "capture", "order", "order", "order", "refund"]);
    expect(JSON.stringify(evidence)).not.toMatch(/checkoutnow\?token=/);
  });

  it("writes the evidence folder with a readable summary", async () => {
    const proof = await run();
    const evidence = await collectEvidence(handle.db, paypal, proof, source);
    const directory = await mkdtemp(path.join(tmpdir(), "setti-proof-"));
    try {
      await writeEvidence(directory, evidence);
      const readme = await readFile(path.join(directory, "README.md"), "utf8");
      expect(readme).toContain(`**Result: all ${evidence.checks.length} checks passed.**`);
      expect(readme).toContain("`0123456`");
      expect(JSON.parse(await readFile(path.join(directory, "provider-verification.json"), "utf8"))).toMatchObject({ environment: "sandbox", passed: true });
      expect(JSON.parse(await readFile(path.join(directory, "ledger.json"), "utf8")).items).toHaveLength(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails the proof when PayPal lists a refund the ledger does not know about", async () => {
    const proof = await run();
    const [capture] = (await collectEvidence(handle.db, paypal, proof, source)).provider.filter((entry) => entry.kind === "capture");
    paypal.refundElsewhere(capture.id, 100, "made-in-the-paypal-dashboard");
    const evidence = await collectEvidence(handle.db, paypal, proof, source);
    expect(evidence.passed).toBe(false);
    expect(evidence.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([expect.stringMatching(/lists exactly the recorded refunds/)]);
    expect(evidenceReadme(evidence)).toContain("**Result: 1 of");
  });

  it("fingerprints the payment source files it ran on", async () => {
    const fingerprint = await sourceFingerprint(process.cwd());
    expect(fingerprint.files.map((file) => file.path)).toContain("src/payments/refund.ts");
    expect(fingerprint.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && !file.path.endsWith(".test.ts"))).toBe(true);
  });
});
