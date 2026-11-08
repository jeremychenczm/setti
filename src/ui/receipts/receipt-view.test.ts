import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonical } from "@/quotes/fingerprint";
import { RECEIPT_FORMAT, RECEIPT_NOT_INCLUDED, type ReceiptPayment, type ReceiptSignature, type VersionReceipt } from "@/receipts/types";
import { certificateRows, paymentGroups, paypalReference, pendingRows, ptDateTime, sealOf, utcTime, verifyCommand } from "./receipt-view";

const document = { title: "Swap the chair for a desk", lines: [{ itemId: "desk", name: "Oak writing desk" }] } as unknown as VersionReceipt["version"]["document"];
const contentHash = createHash("sha256").update(canonical(document)).digest("hex");

const signature = (patch: Partial<ReceiptSignature> = {}): ReceiptSignature => ({
  method: "signed", signingId: null, name: "Emma Park", signature: "Emma Park", at: "2026-10-20T18:03:12.000Z", decision: "approved", note: null,
  itemIds: [], contentHash, revisionContentHash: "b".repeat(64), matches: true, ...patch,
});
const step = (patch: Partial<ReceiptPayment>): ReceiptPayment => ({
  at: "2026-10-20T18:05:00.000Z", itemId: "desk", item: "Oak writing desk", action: "held", amountCents: 110_000,
  paypal: { authorizationId: "9KD20563TY1187340" }, version: 3, broughtForward: false, confirmed: null, ...patch,
});

function receipt(patch: Partial<VersionReceipt> = {}, version: Partial<VersionReceipt["version"]> = {}): VersionReceipt {
  return {
    format: RECEIPT_FORMAT, receiptNo: `MAPLE-V3-${contentHash.slice(0, 8).toUpperCase()}`, issuedAt: "2026-11-07T18:42:00.000Z",
    project: { key: "maple", name: "Maple Ave", room: "Window corner", client: "Emma Park", designer: "Jordan Lee" },
    version: { number: 3, basedOn: 2, status: "approved", replacedBy: null, sentAt: "2026-10-20T16:14:05.000Z", sentBy: "Jordan Lee", contentHash, document, revision: { contentHash: "b".repeat(64), lines: [] }, ...version },
    signatures: [signature()],
    agreement: { kind: "change", changes: [], unchanged: [], source: { kind: "client", vendor: "", notice: "", messages: [] }, terms: "" },
    totals: { previousCents: 150_000, totalCents: 156_000, differenceCents: 6_000 },
    payments: [], pending: null, notIncluded: RECEIPT_NOT_INCLUDED, ...patch,
  };
}

describe("signed version receipt view", () => {
  it("seals a version with what the client did, the day in Pacific time and the fingerprint", () => {
    expect(sealOf(receipt())).toEqual({ word: "CONFIRMED", qualifier: null, date: "20 OCT 2026", code: contentHash.slice(0, 8).toUpperCase(), tone: "ok", ring: "SETTI · SIGNED VERSION RECEIPT · MAPLE AVE · V3 ·" });
    expect(sealOf(receipt({}, { number: 1, status: "partly_approved" }))).toMatchObject({ word: "APPROVED", qualifier: "IN PART", tone: "ok" });
    expect(sealOf(receipt({}, { status: "changes_requested" }))).toMatchObject({ word: "RETURNED", qualifier: "FOR CHANGES", tone: "muted" });
  });

  it("never seals a sample approval as a signature made in Setti", () => {
    const sample = receipt({ signatures: [signature({ method: "sample", contentHash: null })] }, { number: 1, contentHash: null, revision: null });
    expect(sealOf(sample)).toMatchObject({ ring: "SETTI · DEMO SAMPLE APPROVAL · NOT SIGNED IN SETTI ·", code: "SAMPLE" });
    expect(certificateRows(sample)[1]).toMatchObject({ event: "Sample approval (demo)", fingerprint: "b".repeat(64) });
  });

  it("groups the payment record like a statement: each earlier version, then this one", () => {
    const steps = [
      step({ action: "held", amountCents: 80_000, version: 2, broughtForward: true }),
      step({ action: "charged", paypal: { captureId: "5HN88231PL0943822" }, version: 2, broughtForward: true }),
      step({ action: "released", amountCents: 80_000, paypal: { authorizationId: "3SL41270MX8829416" } }),
    ];
    const groups = paymentGroups(receipt({ payments: steps }));
    expect(groups.map((group) => [group.title, group.rows.length])).toEqual([["Brought forward from version 2", 2], ["Under version 3", 1]]);
    expect(steps.map(paypalReference)).toEqual(["Authorization 9KD20563TY1187340", "Capture 5HN88231PL0943822", "Void of 3SL41270MX8829416"]);
    expect(paymentGroups(receipt())).toEqual([]);
  });

  it("combines more than three pending steps of one kind and timing into a row with their total", () => {
    const action = (label: string, kind: "new_authorization" | "capture", amountCents: number) => ({ kind, itemId: label, side: "baseline" as const, label, amountCents, timing: "on_payment_execution" as const, reason: "" });
    const rows = pendingRows({
      actions: [action("Sofa", "new_authorization", 96_791), action("Rug", "new_authorization", 14_136), action("Lamp", "new_authorization", 8_699), action("Desk", "new_authorization", 11_961), action("Consultation", "capture", 30_000)],
      blockers: [], position: { heldCents: 0, capturedCents: 0, refundedCents: 0 },
    });
    expect(rows).toEqual([
      { label: "4 items", items: "Sofa, Rug, Lamp, Desk", kind: "new_authorization", timing: "on_payment_execution", amountCents: 131_587 },
      { label: "Consultation", items: null, kind: "capture", timing: "on_payment_execution", amountCents: 30_000 },
    ]);
  });

  it("lists who sent the version and each signing with the fingerprint recorded then", () => {
    const opening = receipt({ signatures: [signature({ signingId: "a" }), signature({ signingId: "b", at: "2026-10-21T18:00:00.000Z", matches: false })] }, { number: 1 });
    expect(certificateRows(opening).map((row) => [row.event, row.by, row.matches])).toEqual([["Version 1 sent", "Jordan Lee", null], ["Signing 1", "Emma Park", true], ["Signing 2", "Emma Park", false]]);
    expect(ptDateTime("2026-10-20T18:03:12.000Z", true)).toBe("Oct 20, 2026, 11:03:12 AM PDT");
    expect(utcTime("2026-10-20T18:03:12.000Z")).toBe("18:03:12 UTC");
  });

  it("prints a command that recomputes the fingerprint from the downloaded record", () => {
    const r = receipt();
    const dir = mkdtempSync(path.join(tmpdir(), "setti-receipt-"));
    try {
      writeFileSync(path.join(dir, `${r.receiptNo}.json`), JSON.stringify(r, null, 2));
      const code = verifyCommand(r.receiptNo).replace(/^node -e "/, "").replace(/"$/, "");
      expect(execFileSync(process.execPath, ["-e", code], { cwd: dir, encoding: "utf8" }).trim()).toBe(contentHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
