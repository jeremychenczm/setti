/**
 * Shared types for the money rules engine.
 *
 * Every amount is an integer number of US cents. The engine is pure: it
 * decides *what* should happen to the money, never calls PayPal itself.
 */

export type Cents = number;

/** Furniture waits for vendor confirmation before capture; services are charged on approval. */
export type ItemCategory = "furniture" | "service";

/** Where the money for one approved line currently stands. */
export type PaymentState =
  /** Approved price exists, but no money has moved. */
  | { kind: "quoted" }
  /** Authorized (on hold), not yet captured. */
  | { kind: "held"; authorizedCents: Cents }
  /** Captured. `poPlaced` means the studio has already ordered from the vendor. */
  | { kind: "captured"; capturedCents: Cents; poPlaced: boolean };

export interface ExistingLine {
  id: string;
  label: string;
  category: ItemCategory;
  /** Client price on the currently approved revision. */
  priceCents: Cents;
  payment: PaymentState;
}

export type LineChange =
  /** Drop the line. `restockingFeeBps` applies when the vendor return carries a fee (2000 = 20%). */
  | { type: "remove"; lineId: string; restockingFeeBps?: number; nonReturnable?: boolean }
  /** Same item, new client price (tariff surcharge, vendor price change, freight adjustment...). */
  | { type: "reprice"; lineId: string; newPriceCents: Cents }
  /** A brand-new line. */
  | { type: "add"; lineId: string; label: string; category: ItemCategory; priceCents: Cents };

export interface PlanContext {
  /** The client saved PayPal for this project (vault), so the studio can create holds/charges without a new checkout. */
  hasVault: boolean;
  /** Business days after the vendor credit lands before the client refund is promised. */
  refundPromiseBusinessDays?: number;
}

/** One concrete thing that has to happen to the money, with the reason a human can read. */
export type MoneyAction =
  | { kind: "none"; lineId: string; reason: string }
  | { kind: "void_authorization"; lineId: string; releaseCents: Cents; reason: string }
  /** Capture less than authorized when the vendor confirms; the rest is released. */
  | {
      kind: "capture_less";
      lineId: string;
      captureCents: Cents;
      releaseCents: Cents;
      reason: string;
    }
  /** Capture more than authorized, within PayPal's over-capture allowance. */
  | { kind: "over_capture"; lineId: string; captureCents: Cents; extraCents: Cents; reason: string }
  | {
      kind: "new_authorization";
      lineId: string;
      amountCents: Cents;
      via: "vault" | "checkout";
      reason: string;
    }
  | {
      kind: "immediate_capture";
      lineId: string;
      amountCents: Cents;
      via: "vault" | "checkout";
      reason: string;
    }
  /** Merchant-initiated charge against the client's saved PayPal (vault). */
  | { kind: "vault_charge"; lineId: string; amountCents: Cents; reason: string }
  /** No vault: the client has to go through PayPal checkout again for this amount. */
  | { kind: "ask_client_to_pay"; lineId: string; amountCents: Cents; reason: string }
  | {
      kind: "refund";
      lineId: string;
      amountCents: Cents;
      /** Kept by the studio to cover the vendor's restocking fee. */
      retainedCents: Cents;
      timing: "now" | "after_vendor_credit";
      /** Only for `after_vendor_credit`: promise the refund this many business days after the credit lands. */
      promiseBusinessDays?: number;
      reason: string;
    }
  /** Not a PayPal call: the studio has to send the item back to the vendor. */
  | { kind: "vendor_return"; lineId: string; restockingFeeCents: Cents; reason: string };

export interface ChangePlan {
  budgetBeforeCents: Cents;
  budgetAfterCents: Cents;
  /** Change to the approved budget. Not the same thing as "what the client pays now". */
  budgetDeltaCents: Cents;
  actions: MoneyAction[];
  /** How the money moves, kept separate from the budget on purpose. */
  money: {
    releasedCents: Cents;
    refundCents: Cents;
    newHoldCents: Cents;
    newChargeCents: Cents;
  };
}
