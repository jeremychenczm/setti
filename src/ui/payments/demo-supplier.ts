/**
 * The demo has no real supplier, so the supplier's document numbers are filled in
 * for the designer: a readable, clearly fictional number per item. The designer can
 * still change it; the record is labelled as a demo supplier confirmation.
 */
export function demoSupplierNumber(kind: "order" | "credit", itemId: string): string {
  const item = itemId.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ITEM";
  return `DEMO-${kind === "order" ? "SO" : "CN"}-${item}`;
}
