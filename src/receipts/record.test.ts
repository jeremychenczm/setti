import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { paymentOperations, paypalAuthorizations, paypalCaptures } from "../db/schema";
import { signOpeningForTest } from "../opening/testing";
import { returnFromPayPal, startAuthorization, startCapture, startRelease } from "../payments/actions";
import { recordSupplierOrder } from "../payments/supplier";
import { confirmChanges, shown } from "../payments/testing/cases";
import { FakePayPal } from "../payments/testing/fake-paypal";
import { links } from "../payments/testing/flows";
import type { FrozenChangeOrder, PricingItem } from "../pricing/types";
import { addTestProject, CHAIR, SOFA, TEST_KEY, V1_CENTS } from "../projects/testing";
import { hashRevision } from "../quotes/hash";
import { readVersionReceipt, ReceiptError } from "./record";
import type { VersionReceipt } from "./types";

/** What a reader runs on the downloaded file, written independently of Setti's own code. */
function readerFingerprint(file: string): string {
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
      : JSON.stringify(value);
  return createHash("sha256").update(canonical(JSON.parse(file).version.document)).digest("hex");
}

/** Fixed supplier terms are test inputs, not claims about a real seller. */
function product(name: string, sku: string, unitPriceCents: number): Partial<PricingItem> {
  return { name, vendor: "Demo supplier", sku, specification: name, quantity: 1, unitLabel: "each", currency: "USD", unitPriceCents, taxCents: 0, freightCents: 0, returnable: true, returnPolicy: "Demo terms reviewed by the designer." };
}

const refused = (code: ReceiptError["code"]) => expect.objectContaining({ name: "ReceiptError", code });

describe.skipIf(!testDatabaseUrl)("signed version receipts", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;

  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    await addTestProject(handle.db, session);
  });
  afterAll(() => handle?.pool.end());

  describe("a V1 signed line by line in two sittings", () => {
    let receipt: VersionReceipt;
    beforeEach(async () => {
      await signOpeningForTest(handle.db, session, TEST_KEY, [
        { itemId: SOFA, decision: "approved" },
        { itemId: CHAIR, decision: "declined", note: "Too small for the table." },
      ]);
      await signOpeningForTest(handle.db, session, TEST_KEY);
      receipt = await readVersionReceipt(handle.db, session, TEST_KEY, 1);
    });

    it("lists each signing with the lines it decided and the fingerprint it was bound to", () => {
      expect(receipt.signatures).toHaveLength(2);
      const [first, second] = receipt.signatures;
      expect(first).toMatchObject({ method: "signed", name: "Ava Chen", decision: "mixed", matches: true, revisionContentHash: receipt.version.revision!.contentHash });
      expect(new Set(first.itemIds)).toEqual(new Set([SOFA, CHAIR]));
      expect(second).toMatchObject({ method: "signed", decision: "approved", matches: true });
      expect(second.itemIds).toHaveLength(4);
      expect(first.signingId).not.toBe(second.signingId);
    });

    it("gives every line its decision, and the version its status and total", () => {
      if (receipt.agreement.kind !== "opening") throw new Error("expected a V1 receipt");
      const byId = new Map(receipt.agreement.lines.map((line) => [line.itemId, line]));
      expect(byId.get(CHAIR)).toMatchObject({ decision: "declined", note: "Too small for the table.", decidedBy: "Ava Chen", signingId: receipt.signatures[0].signingId });
      expect(byId.get(SOFA)).toMatchObject({ decision: "approved", signingId: receipt.signatures[0].signingId });
      expect(receipt.version).toMatchObject({ number: 1, basedOn: null, status: "partly_approved", replacedBy: null, sentBy: "Jordan Lee" });
      expect(receipt.totals).toEqual({ previousCents: null, totalCents: V1_CENTS, differenceCents: null });
      expect(receipt.receiptNo).toBe(`FERNHILL-V1-${receipt.version.contentHash!.slice(0, 8).toUpperCase()}`);
      expect(receipt.pending).toMatchObject({ actions: expect.any(Array), blockers: [] });
    });

    it("lets a reader recompute both fingerprints from the downloaded file", () => {
      const file = JSON.stringify(receipt);
      expect(readerFingerprint(file)).toBe(receipt.version.contentHash);
      expect(hashRevision(JSON.parse(file).version.revision.lines)).toBe(receipt.version.revision!.contentHash);
    });
  });

  it("refuses a V1 that was not sent", async () => {
    await expect(readVersionReceipt(handle.db, session, TEST_KEY, 1)).rejects.toEqual(refused("NOT_SENT"));
  });

  it("refuses another session's project and a version that does not exist", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    await expect(readVersionReceipt(handle.db, randomUUID(), TEST_KEY, 1)).rejects.toEqual(refused("NOT_FOUND"));
    await expect(readVersionReceipt(handle.db, session, TEST_KEY, 2)).rejects.toEqual(refused("NOT_FOUND"));
  });

  it("reads a sent version the client has not signed as its formal quote, awaiting the signature", async () => {
    const sent = await confirmChanges(handle.db, session, "maple", [{ action: "replace", itemId: "chair", after: product("Oak writing desk", "DEMO-DESK-1", 110_000) }], false);
    const quote = await readVersionReceipt(handle.db, session, "maple", 2);
    expect(quote.version).toMatchObject({ number: 2, status: "awaiting_signature", contentHash: sent.contentHash, sentAt: sent.issuedAt });
    expect(quote).toMatchObject({ signatures: [], pending: null, receiptNo: `MAPLE-V2-${sent.contentHash.slice(0, 8).toUpperCase()}` });
    expect(readerFingerprint(JSON.stringify(quote))).toBe(sent.contentHash);
    await signOpeningForTest(handle.db, session, TEST_KEY, []);
    expect((await readVersionReceipt(handle.db, session, TEST_KEY, 1)).version.status).toBe("awaiting_signature");
  });

  describe("a later version with money on its items", () => {
    let paypal: FakePayPal;
    let initial: FrozenChangeOrder;
    let mixed: FrozenChangeOrder;
    const ref = (itemId: string, side: "baseline" | "proposed" = "baseline") => ({ itemId, side });

    async function authorize(order: FrozenChangeOrder, itemId: string) {
      const checkout = await startAuthorization(handle.db, paypal, session, order.id, { ...ref(itemId, "proposed"), ...shown(order) }, links);
      paypal.approve(checkout.paypalOrderId!);
      await returnFromPayPal(handle.db, paypal, checkout.id, checkout.paypalOrderId, "return");
    }

    beforeEach(async () => {
      paypal = new FakePayPal();
      // V2 holds the chair and the rug and charges the rug; V3 replaces the chair and returns the rug.
      initial = await confirmChanges(handle.db, session, "maple", [
        { action: "replace", itemId: "chair", after: product("Confirmed lounge chair", "DEMO-CHAIR-2", 80_000) },
        { action: "replace", itemId: "rug", after: product("Confirmed wool rug", "DEMO-RUG-2", 30_000) },
      ]);
      await authorize(initial, "chair");
      await authorize(initial, "rug");
      const rug = initial.lines.find((line) => line.itemId === "rug")!;
      await recordSupplierOrder(handle.db, session, initial.id, {
        ...ref("rug", "proposed"), ...shown(initial), quantity: 1, unitPriceCents: rug.unitPriceCents, taxCents: rug.taxCents, freightCents: rug.freightCents,
        inStock: true, leadTimeDays: 14, reference: "DEMO-ORDER-rug", note: "Demo confirmation entered by designer.",
      });
      await startCapture(handle.db, paypal, session, initial.id, { ...ref("rug", "proposed"), ...shown(initial) });
      mixed = await confirmChanges(handle.db, session, "maple", [
        { action: "replace", itemId: "chair", after: product("Oak writing desk", "DEMO-DESK-1", 110_000), oldItemHandling: "not_ordered", oldItemCostCents: 0 },
        { action: "remove", itemId: "rug", oldItemHandling: "returned", oldItemCostCents: 6_000 },
      ]);
      await startRelease(handle.db, paypal, session, mixed.id, { ...ref("chair"), ...shown(mixed) });
      await authorize(mixed, "chair");
    });

    it("states what changed, why, the totals, and a signature bound to this exact version", async () => {
      const receipt = await readVersionReceipt(handle.db, session, "maple", 3);
      expect(receipt.version).toMatchObject({ number: 3, basedOn: 2, status: "approved", replacedBy: null, contentHash: mixed.contentHash });
      expect(receipt.signatures).toEqual([expect.objectContaining({ method: "signed", decision: "approved", name: "Emma Park", contentHash: mixed.contentHash, revisionContentHash: mixed.revisionContentHash, matches: true })]);
      if (receipt.agreement.kind !== "change") throw new Error("expected a change receipt");
      expect(receipt.agreement.changes).toEqual([
        expect.objectContaining({ itemId: "chair", action: "replace", before: expect.objectContaining({ name: "Confirmed lounge chair", totalCents: 80_000 }), after: expect.objectContaining({ name: "Oak writing desk", totalCents: 110_000 }), oldItem: { handling: "not_ordered", retainedCents: 0, fees: [], note: expect.any(String) } }),
        expect.objectContaining({ itemId: "rug", action: "remove", after: null, oldItem: expect.objectContaining({ handling: "returned", retainedCents: 6_000, fees: [{ kind: "restocking_fee", amountCents: 6_000 }] }) }),
      ]);
      expect(receipt.agreement.source.messages).toEqual(mixed.sourceMessages.map(({ id, actor, text, createdAt }) => ({ id, actor, text, createdAt })));
      expect(receipt.agreement.terms).toBe(mixed.terms);
      expect(receipt.totals).toEqual({ previousCents: mixed.baselineTotals.totalCents, totalCents: 156_000, differenceCents: 6_000 });
      expect(readerFingerprint(JSON.stringify(receipt))).toBe(mixed.contentHash);
    });

    it("records this version's PayPal steps and brings the earlier ones on its items forward", async () => {
      const receipt = await readVersionReceipt(handle.db, session, "maple", 3);
      const holds = await handle.db.select().from(paypalAuthorizations);
      const [charge] = await handle.db.select().from(paypalCaptures);
      const hold = (cents: number) => holds.find((entry) => entry.amountCents === cents)!.paypalAuthorizationId;
      const steps = receipt.payments.map(({ item, action, amountCents, paypal: ids, version, broughtForward }) => ({ item, action, amountCents, ids, version, broughtForward }));
      expect(steps).toHaveLength(5);
      expect(steps).toEqual(expect.arrayContaining([
        { item: "Confirmed lounge chair", action: "held", amountCents: 80_000, ids: { authorizationId: hold(80_000) }, version: 2, broughtForward: true },
        { item: "Confirmed wool rug", action: "held", amountCents: 30_000, ids: { authorizationId: hold(30_000) }, version: 2, broughtForward: true },
        { item: "Confirmed wool rug", action: "charged", amountCents: 30_000, ids: { captureId: charge.paypalCaptureId }, version: 2, broughtForward: true },
        { item: "Confirmed lounge chair", action: "released", amountCents: 80_000, ids: { authorizationId: hold(80_000) }, version: 3, broughtForward: false },
        { item: "Oak writing desk", action: "held", amountCents: 110_000, ids: { authorizationId: hold(110_000) }, version: 3, broughtForward: false },
      ]));
      expect(receipt.payments.every((step) => step.confirmed !== null)).toBe(true);
      expect(receipt.pending?.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ itemId: "chair", side: "proposed", kind: "capture", amountCents: 110_000, timing: "after_vendor_confirmation" }),
        expect.objectContaining({ itemId: "rug", side: "baseline", kind: "refund", amountCents: 24_000, timing: "after_vendor_credit" }),
      ]));
      expect(receipt.pending?.position).toEqual({ heldCents: 110_000, capturedCents: 30_000, refundedCents: 0 });
    });

    it("keeps a replaced version's receipt to its own steps, with nothing pending", async () => {
      const receipt = await readVersionReceipt(handle.db, session, "maple", 2);
      expect(receipt.version).toMatchObject({ number: 2, replacedBy: 3, contentHash: initial.contentHash });
      expect(receipt.payments.map((step) => [step.action, step.amountCents, step.version])).toEqual(expect.arrayContaining([["held", 80_000, 2], ["held", 30_000, 2], ["charged", 30_000, 2]]));
      expect(receipt.payments).toHaveLength(3);
      expect(receipt.pending).toBeNull();
    });

    it("marks Maple's V1 as the demo's sample approval, not a signature made in Setti", async () => {
      const receipt = await readVersionReceipt(handle.db, session, "maple", 1);
      expect(receipt.signatures).toEqual([expect.objectContaining({ method: "sample", signingId: null, name: "Emma Park", decision: "approved", contentHash: null, matches: true })]);
      expect(receipt.version).toMatchObject({ contentHash: null, replacedBy: 2, status: "approved" });
      expect(receipt.receiptNo).toBe(`MAPLE-V1-${receipt.version.revision!.contentHash.slice(0, 8).toUpperCase()}`);
      expect(receipt.payments).toEqual([]);
      expect(receipt.pending).toBeNull();
    });

    it("leaves out approval links and request ids", async () => {
      const file = JSON.stringify(await readVersionReceipt(handle.db, session, "maple", 3));
      const operations = await handle.db.select().from(paymentOperations);
      expect(operations.length).toBeGreaterThan(0);
      for (const operation of operations) {
        expect(file).not.toContain(operation.requestId);
        if (operation.approvalUrl) expect(file).not.toContain(operation.approvalUrl);
      }
      expect(file).not.toMatch(/approvalUrl|requestId/);
    });
  });
});
