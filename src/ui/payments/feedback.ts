export interface PaymentFeedback {
  actionError: string | null;
  readError: string | null;
}

export type FeedbackEvent =
  | { type: "action_started" }
  | { type: "action_failed"; message: string }
  | { type: "records_loaded" }
  | { type: "records_failed"; message: string };

export const emptyPaymentFeedback: PaymentFeedback = { actionError: null, readError: null };

/** Refreshing the ledger must not erase why the preceding action was refused. */
export function paymentFeedback(state: PaymentFeedback, event: FeedbackEvent): PaymentFeedback {
  switch (event.type) {
    case "action_started": return emptyPaymentFeedback;
    case "action_failed": return { ...state, actionError: event.message };
    case "records_loaded": return { ...state, readError: null };
    case "records_failed": return { ...state, readError: event.message };
  }
}

export function feedbackMessage(state: PaymentFeedback): string | null {
  const errors = [...new Set([state.actionError, state.readError].filter((message): message is string => !!message))];
  return errors.length ? errors.join(" ") : null;
}

const returnNotices: Record<string, string> = {
  authorized: "Checkout return received. Check the current payment records below for held, captured, refunded and released amounts.",
  awaiting_buyer: "Checkout return received. Continue the same checkout or check its current PayPal status below.",
  cancelled: "The checkout was left. Check its status below or continue the same checkout; PayPal receipts determine whether an amount is held.",
  failed: "Checkout return received. Check the current payment records and any failure reason below before trying again.",
  unknown: "Check the current PayPal status below to reconcile any open payment step.",
  unmatched: "This checkout return could not be matched. Check the payment step below from the browser that owns the case.",
};

/** A return URL is navigation context, never evidence of the current balance. */
export function paymentReturnNotice(returned: string | null): { tone: "warn"; text: string } | null {
  return returned && returnNotices[returned] ? { tone: "warn", text: returnNotices[returned] } : null;
}
