/**
 * Client inbox scenarios for the summary eval: each is a timeline of PayPal
 * results (holds, charges, releases, refunds) replayed into the records the
 * inbox reads, plus where each item truly stands at the end. All data is fictional.
 */
import type { MoneyEvent } from "@/payments/money-events";

export interface Hold { id: string; itemId: string | null; amountCents: number; capturedCents: number; status: "created" | "partially_captured" | "captured" | "voided"; services: boolean }
export interface Capture { id: string; holdId: string; itemId: string | null; amountCents: number }
export interface Refund { id: string; captureId: string; amountCents: number }

export interface Timeline {
  labels: Record<string, string>;
  holds: Hold[];
  captures: Capture[];
  refunds: Refund[];
  events: MoneyEvent[];
}

/** Where one item's money stands at the end of a scenario, worked out from the timeline alone. */
export interface ItemTruth { itemId: string; label: string; heldCents: number; chargedCents: number; refundedCents: number; releasedCents: number }

export interface Scenario {
  id: string;
  title: string;
  tags: string[];
  timeline: () => Timeline;
}

class Builder {
  readonly timeline: Timeline;
  private n = 0;
  constructor(labels: Record<string, string>) { this.timeline = { labels, holds: [], captures: [], refunds: [], events: [] }; }
  private event(kind: MoneyEvent["kind"], itemId: string | null, amountCents: number, at: string) {
    this.n += 1;
    this.timeline.events.push({ id: `op-${String(this.n).padStart(3, "0")}`, kind, itemLabel: itemId ? this.timeline.labels[itemId] : "Design services", amountCents, at, paypalId: null, checked: null });
  }
  hold(id: string, itemId: string | null, amountCents: number, at: string, services = false) {
    this.timeline.holds.push({ id, itemId, amountCents, capturedCents: 0, status: "created", services });
    if (!services) this.event("held", itemId, amountCents, at);
    return this;
  }
  /** Captures from a hold; a final capture below the hold releases the rest. */
  charge(holdId: string, amountCents: number, at: string, final = true, itemId?: string) {
    const hold = this.timeline.holds.find((entry) => entry.id === holdId)!;
    hold.capturedCents += amountCents;
    hold.status = final || hold.capturedCents >= hold.amountCents ? "captured" : "partially_captured";
    const charged = itemId ?? hold.itemId;
    this.timeline.captures.push({ id: `cap-${holdId}-${hold.capturedCents}`, holdId, itemId: charged, amountCents });
    this.event("charged", charged, amountCents, at);
    return this;
  }
  release(holdId: string, at: string) {
    const hold = this.timeline.holds.find((entry) => entry.id === holdId)!;
    hold.status = "voided";
    this.event("released", hold.itemId, hold.amountCents, at);
    return this;
  }
  refund(captureId: string, amountCents: number, at: string) {
    const capture = this.timeline.captures.find((entry) => entry.id === captureId)!;
    this.timeline.refunds.push({ id: `ref-${captureId}`, captureId, amountCents });
    this.event("refunded", capture.itemId, amountCents, at);
    return this;
  }
  done(): Timeline {
    this.timeline.events.sort((a, b) => b.at.localeCompare(a.at));
    return this.timeline;
  }
}

export function truthOf(timeline: Timeline): { items: ItemTruth[]; heldCents: number; chargedCents: number; refundedCents: number } {
  const ids = [...new Set([...timeline.holds.map((hold) => hold.itemId), ...timeline.captures.map((capture) => capture.itemId)])];
  const items = ids.map((itemId) => {
    const holds = timeline.holds.filter((hold) => hold.itemId === itemId && !hold.services);
    const captures = timeline.captures.filter((capture) => capture.itemId === itemId);
    return {
      itemId: itemId ?? "services", label: itemId ? timeline.labels[itemId] : "Design services",
      heldCents: holds.filter((hold) => hold.status === "created" || hold.status === "partially_captured").reduce((sum, hold) => sum + hold.amountCents - hold.capturedCents, 0),
      chargedCents: captures.reduce((sum, capture) => sum + capture.amountCents, 0),
      refundedCents: timeline.refunds.filter((refund) => captures.some((capture) => capture.id === refund.captureId)).reduce((sum, refund) => sum + refund.amountCents, 0),
      releasedCents: holds.reduce((sum, hold) => sum + (hold.status === "voided" ? hold.amountCents : hold.status === "captured" ? hold.amountCents - hold.capturedCents : 0), 0),
    };
  });
  const sum = (key: "heldCents" | "chargedCents" | "refundedCents") => items.reduce((total, item) => total + item[key], 0);
  // The services hold is charged at once and never shown as a hold; an entry with no money is not an item.
  return { items: items.filter((item) => item.heldCents || item.chargedCents || item.refundedCents || item.releasedCents), heldCents: sum("heldCents"), chargedCents: sum("chargedCents"), refundedCents: sum("refundedCents") };
}

const MAPLE = {
  design: "Design services", sideboard: "Dining sideboard", sofa: "Three-seat sofa", coffee: "Large rectangular coffee table",
  table: "Fixed six-person dining table", chairs: "Upholstered dining chairs", compact: "Compact sofa", side: "Small round side table", round: "Round dining table",
};

/** Maple's starting payments: the design fee and the sideboard are charged within seconds of their holds. */
function mapleStart(): Builder {
  return new Builder(MAPLE)
    .hold("h-design", null, 100_000, "2026-11-02T03:50:05Z", true).charge("h-design", 100_000, "2026-11-02T03:50:09Z", true, "design")
    .hold("h-sideboard", "sideboard", 120_000, "2026-11-02T03:50:11Z").charge("h-sideboard", 120_000, "2026-11-02T03:50:15Z")
    .hold("h-sofa", "sofa", 240_000, "2026-11-02T03:50:20Z").hold("h-coffee", "coffee", 65_000, "2026-11-02T03:50:22Z")
    .hold("h-table", "table", 140_000, "2026-11-02T03:50:24Z").hold("h-chairs", "chairs", 108_000, "2026-11-02T03:50:26Z");
}

/** After the client confirms V2: three old holds released, three new items held. */
function mapleAfterV2(): Builder {
  return mapleStart()
    .release("h-sofa", "2026-11-02T05:40:10Z").release("h-coffee", "2026-11-02T05:40:12Z").release("h-table", "2026-11-02T05:40:14Z")
    .hold("h-compact", "compact", 210_000, "2026-11-02T05:40:20Z").hold("h-round", "round", 125_000, "2026-11-02T05:40:22Z").hold("h-side", "side", 36_000, "2026-11-02T05:40:24Z");
}

function largeProject(): Timeline {
  const names = ["Three-seat sofa", "Lounge armchair", "Walnut coffee table", "Round side table", "Media console", "Glass-door shelf unit", "Floor lamp", "Low-pile area rug", "Dining table", "Dining chairs", "LED pendant lamp", "Writing desk", "Office chair", "Bookcases", "Sideboard", "Engineered oak flooring", "Porcelain floor tile", "Interior wall paint"];
  const labels = Object.fromEntries(names.map((name, index) => [`w${index}`, name]));
  const builder = new Builder(labels).hold("h-design", null, 453_000, "2026-11-03T16:00:00Z", true).charge("h-design", 453_000, "2026-11-03T16:00:05Z", true, null as unknown as string);
  names.forEach((_, index) => builder.hold(`h${index}`, `w${index}`, 20_000 + index * 7_500, `2026-11-03T16:01:${String(index).padStart(2, "0")}Z`));
  [0, 2, 8, 9, 15, 16].forEach((index, order) => builder.charge(`h${index}`, 20_000 + index * 7_500, `2026-11-04T18:0${order}:00Z`));
  [5, 6, 13].forEach((index, order) => builder.release(`h${index}`, `2026-11-04T19:0${order}:00Z`));
  builder.refund("cap-h2-35000", 5_000, "2026-11-04T20:00:00Z");
  return builder.done();
}

export const SCENARIOS: Scenario[] = [
  { id: "client-held-then-charged", tags: ["client", "held-then-charged"], title: "The sideboard was held and charged within seconds; four items are still on hold", timeline: () => mapleStart().done() },
  { id: "client-after-v2", tags: ["client", "released-and-reheld"], title: "Three old holds released and three new items held after V2", timeline: () => mapleAfterV2().done() },
  { id: "client-smaller-capture", tags: ["client", "partial"], title: "Chairs charged for four with the rest released; the compact sofa charged in full", timeline: () => mapleAfterV2().charge("h-chairs", 72_000, "2026-11-04T17:00:00Z", true).charge("h-compact", 210_000, "2026-11-04T17:05:00Z").done() },
  { id: "client-refund", tags: ["client", "refund"], title: "A charged sideboard refunded except the retained cost", timeline: () => mapleAfterV2().charge("h-chairs", 72_000, "2026-11-04T17:00:00Z", true).charge("h-compact", 210_000, "2026-11-04T17:05:00Z").refund("cap-h-sideboard-120000", 96_000, "2026-11-05T15:00:00Z").done() },
  { id: "client-renewed-hold", tags: ["client", "renewal"], title: "The compact sofa's hold renewed: a new hold first, then the old one released", timeline: () => mapleAfterV2().hold("h-compact-2", "compact", 210_000, "2026-11-27T15:00:00Z").release("h-compact", "2026-11-27T15:00:10Z").done() },
  { id: "client-all-settled", tags: ["client", "settled"], title: "Everything charged or released: nothing is on hold any more", timeline: () => mapleAfterV2().charge("h-chairs", 72_000, "2026-11-04T17:00:00Z", true).charge("h-compact", 210_000, "2026-11-04T17:05:00Z").charge("h-round", 125_000, "2026-11-04T17:06:00Z").charge("h-side", 36_000, "2026-11-04T17:07:00Z").done() },
  { id: "client-large-project", tags: ["client", "large"], title: "Eighteen items: six charged, three released, one partial refund, more events than the inbox lists", timeline: largeProject },
];
