import { describe, expect, it } from "vitest";
import { willowQuote } from "@/quotes/willow-quote";
import { defaultOpening, documentHash, openingDocument, withoutApproval } from "./document";
import { sampleProject } from "@/demo/sample-projects";

describe("opening quote document", () => {
  it("carries the quote's lines and terms but no approval, signature or approval date", () => {
    const document = openingDocument(sampleProject("willow")!);
    expect(document.lines).toHaveLength(26);
    expect(document.lines[0]).toMatchObject({ itemId: "willow-sofa", unitPriceCents: 79_900, freightCents: 9_900 });
    for (const field of ["status", "approvedAt", "approvedBy", "signature"]) expect(document).not.toHaveProperty(field);
    for (const line of document.lines) expect(line).not.toHaveProperty("approval");
  });

  it("hashes the canonical document, so the same content always gives the same hash", () => {
    const hash = documentHash(openingDocument(sampleProject("willow")!));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(documentHash(withoutApproval(structuredClone(willowQuote)))).toBe(hash);
    const changed = openingDocument(sampleProject("willow")!);
    changed.lines = changed.lines.map((line, index) => index === 0 ? { ...line, unitPriceCents: line.unitPriceCents + 1 } : line);
    expect(documentHash(changed)).not.toBe(hash);
  });

  it("starts Willow as an unsent draft and Maple as the demo's approved V1", () => {
    expect(defaultOpening(sampleProject("willow")!)).toMatchObject({ status: "draft", version: 1, lineCount: 26, totalCents: 1_517_489, messageId: null, contentHash: null });
    expect(defaultOpening(sampleProject("maple")!)).toMatchObject({ status: "approved", lineCount: 3, totalCents: 150_000 });
  });
});
