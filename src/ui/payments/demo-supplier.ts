/**
 * The demo has no real supplier, so the supplier's document numbers are filled in
 * for the designer: a readable, clearly fictional number per item. The designer can
 * still change it; the record is labelled as a demo supplier confirmation.
 */
export function demoSupplierNumber(kind: "order" | "credit", itemId: string, label?: string): string {
  // The item's name reads better than its id and never repeats on one quote; a long id keeps its own end, which differs.
  const slug = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const named = label ? slug(label).slice(0, 32).replace(/-+$/, "") : "";
  const id = slug(itemId);
  const item = named || (id.length > 40 ? `${id.slice(0, 20)}-${id.slice(-12)}` : id) || "ITEM";
  return `DEMO-${kind === "order" ? "SO" : "CN"}-${item}`;
}
