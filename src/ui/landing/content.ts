/**
 * Facts the landing page states about Setti. The Maple numbers are the demo
 * project's own (see content.test.ts), so the page cannot drift from the app.
 */
import { HOME_DESIGNER_REQUEST, HOME_DISCUSSION } from "@/demo/living-dining";

export const GITHUB_URL = "https://github.com/jeremychenczm/setti";
export const SECURITY_URL = `${GITHUB_URL}/blob/main/SECURITY.md`;
/** The walkthrough on YouTube. The video section and its button stay hidden until this is set. */
export const DEMO_VIDEO_URL: string | null = null;

export interface MapleChange { itemId: string; name: string; change: string; beforeCents: number; afterCents: number }

/** The five furniture changes in Maple's revised quote, V1 price to V2 price. */
export const MAPLE_CHANGES: readonly MapleChange[] = [
  { itemId: "sofa", name: "Sofa", change: "230 cm → compact 200 cm", beforeCents: 240_000, afterCents: 210_000 },
  { itemId: "coffee-table", name: "Coffee table", change: "→ two round side tables", beforeCents: 65_000, afterCents: 36_000 },
  { itemId: "dining-table", name: "Dining table", change: "six seats → round, 110 cm", beforeCents: 140_000, afterCents: 125_000 },
  { itemId: "dining-chairs", name: "Dining chairs", change: "6 → 4", beforeCents: 108_000, afterCents: 72_000 },
  { itemId: "sideboard", name: "Sideboard", change: "removed · supplier keeps 20%", beforeCents: 120_000, afterCents: 24_000 },
];
/** The design fee, unchanged by the revision. */
export const DESIGN_FEE_CENTS = 100_000;
export const V1_TOTAL_CENTS = DESIGN_FEE_CENTS + MAPLE_CHANGES.reduce((sum, line) => sum + line.beforeCents, 0);
export const V2_TOTAL_CENTS = DESIGN_FEE_CENTS + MAPLE_CHANGES.reduce((sum, line) => sum + line.afterCents, 0);

export type MoveKind = "released" | "held" | "charged" | "refunded" | "kept";
export interface MoneyMove { itemId: string; name: string; moves: readonly { kind: MoveKind; cents: number }[]; note?: string }

/** What PayPal does for each item once the client signs V2. */
export const MAPLE_MONEY: readonly MoneyMove[] = [
  { itemId: "sofa", name: "Sofa", moves: [{ kind: "released", cents: 240_000 }, { kind: "held", cents: 210_000 }] },
  { itemId: "coffee-table", name: "Coffee table", moves: [{ kind: "released", cents: 65_000 }, { kind: "held", cents: 36_000 }] },
  { itemId: "dining-table", name: "Dining table", moves: [{ kind: "released", cents: 140_000 }, { kind: "held", cents: 125_000 }] },
  { itemId: "dining-chairs", name: "Dining chairs", moves: [{ kind: "charged", cents: 72_000 }, { kind: "released", cents: 36_000 }], note: "once the supplier confirms four chairs" },
  { itemId: "sideboard", name: "Sideboard", moves: [{ kind: "refunded", cents: 96_000 }, { kind: "kept", cents: 24_000 }], note: "once the supplier issues its credit" },
];

export const MOVE_LABEL: Record<MoveKind, string> = {
  released: "Hold released", held: "New hold", charged: "Charged", refunded: "Refunded", kept: "Kept",
};

/** The client's message that settles the chairs and the sideboard, and the designer's request to the agent. */
export const EMMA_MESSAGE = HOME_DISCUSSION[12].text;
export const JORDAN_REQUEST = HOME_DESIGNER_REQUEST;
export const DISCUSSION_LENGTH = HOME_DISCUSSION.length;

/** AI eval results from the README's AI quality section, 5 November 2026. */
export const EVAL_RESULTS = { drafts: [65, 65], money: [14, 14], inbox: [21, 21] } as const;

export function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
