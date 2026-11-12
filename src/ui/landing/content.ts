/**
 * Facts the landing page states about Setti. The Maple numbers are the demo
 * project's own (see content.test.ts), so the page cannot drift from the app.
 */
import { HOME_DESIGNER_REQUEST, HOME_DISCUSSION } from "@/demo/living-dining";

export const GITHUB_URL = "https://github.com/jeremychenczm/setti";
export const SECURITY_URL = `${GITHUB_URL}/blob/main/SECURITY.md`;
/** The walkthrough's YouTube video id. The video section and its button stay hidden until this is set. */
export const DEMO_VIDEO_ID: string | null = "FywJrEkjdC0";

export interface MapleChange { itemId: string; name: string; change: string; beforeCents: number; afterCents: number }

/** The seven changes in Maple Ave Café's revised quote, V1 price to V2 price. A re-cut or a return
 * counts the fee the supplier keeps; the window counter and the panels are new, so they have no V1 price. */
export const MAPLE_CHANGES: readonly MapleChange[] = [
  { itemId: "stools", name: "Counter stools", change: "8 → 14", beforeCents: 156_000, afterCents: 273_000 },
  { itemId: "window-counter", name: "Oak window counter", change: "new · 16 ft", beforeCents: 0, afterCents: 336_000 },
  { itemId: "panels", name: "Acoustic panels", change: "new · 12", beforeCents: 0, afterCents: 174_000 },
  { itemId: "countertop", name: "Quartz countertop", change: "22 → 18 ft · re-cut fee kept", beforeCents: 396_000, afterCents: 352_000 },
  { itemId: "pendants", name: "Pendant lights", change: "6 → 4", beforeCents: 144_000, afterCents: 96_000 },
  { itemId: "wall-tile", name: "Wall tile", change: "white → sage · 14 → 20 boxes", beforeCents: 98_000, afterCents: 171_600 },
  { itemId: "site-visits", name: "Site visits", change: "4 → 6", beforeCents: 72_000, afterCents: 108_000 },
];
/** The design fee, unchanged by the revision. */
export const DESIGN_FEE_CENTS = 240_000;
export const V1_TOTAL_CENTS = DESIGN_FEE_CENTS + MAPLE_CHANGES.reduce((sum, line) => sum + line.beforeCents, 0);
export const V2_TOTAL_CENTS = DESIGN_FEE_CENTS + MAPLE_CHANGES.reduce((sum, line) => sum + line.afterCents, 0);

export type MoveKind = "released" | "held" | "charged" | "refunded" | "kept";
export interface MoneyMove { itemId: string; name: string; moves: readonly { kind: MoveKind; cents: number }[]; note?: string }

/** What PayPal does for each item once the client signs V2. */
export const MAPLE_MONEY: readonly MoneyMove[] = [
  { itemId: "stools", name: "Counter stools", moves: [{ kind: "held", cents: 117_000 }], note: "the six extra stools, on top of the eight already held" },
  { itemId: "window-counter", name: "Oak window counter", moves: [{ kind: "held", cents: 336_000 }] },
  { itemId: "panels", name: "Acoustic panels", moves: [{ kind: "held", cents: 174_000 }] },
  { itemId: "countertop", name: "Quartz countertop", moves: [{ kind: "refunded", cents: 44_000 }, { kind: "kept", cents: 352_000 }], note: "once the fabricator credits the 4 ft it cut off" },
  { itemId: "pendants", name: "Pendant lights", moves: [{ kind: "charged", cents: 96_000 }, { kind: "released", cents: 48_000 }], note: "once the supplier confirms four lights" },
  { itemId: "wall-tile", name: "Wall tile", moves: [{ kind: "refunded", cents: 78_400 }, { kind: "kept", cents: 19_600 }, { kind: "held", cents: 152_000 }], note: "the white boxes go back; the sage boxes are held" },
  { itemId: "site-visits", name: "Site visits", moves: [{ kind: "charged", cents: 36_000 }], note: "Emma pays for the two extra visits on PayPal" },
];

export const MOVE_LABEL: Record<MoveKind, string> = {
  released: "Hold released", held: "New hold", charged: "Charged", refunded: "Refunded", kept: "Kept",
};

/** The client's message that starts the change, and the designer's request to the agent. */
export const EMMA_MESSAGE = HOME_DISCUSSION[0].text;
export const JORDAN_REQUEST = HOME_DESIGNER_REQUEST;
export const DISCUSSION_LENGTH = HOME_DISCUSSION.length;

/** AI eval results from the README's AI quality section, 5 November 2026. */
export const EVAL_RESULTS = { drafts: [65, 65], money: [14, 14], inbox: [21, 21] } as const;

export function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
