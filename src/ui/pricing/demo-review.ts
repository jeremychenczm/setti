import type { ChangeDraft } from "@/chat/types";
import { isHomeQuote } from "@/demo/home-evidence";
import { createPricingInput } from "@/pricing/calculation";
import type { ApprovedQuoteReport } from "@/quotes/types";

/** Walkthrough convenience, separate from AI output and saved designer decisions. */
export function createReviewInput(quote: ApprovedQuoteReport, draft: ChangeDraft) {
  const input = createPricingInput(quote, draft);
  if (!isHomeQuote(quote)) return input;
  return {
    ...input,
    changes: input.changes.map((change) => ({ ...change, confirmed: true })),
    issues: input.issues.map((issue) => ({ ...issue, resolved: true })),
    reviewNotes: "Demo walkthrough: review checks are preselected for convenience. Prices reference local fictional supplier documents. These checks do not establish actual measurements, supplier approval, orders or payments; those need their own evidence.",
  };
}
