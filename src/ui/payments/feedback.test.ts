import { describe, expect, it } from "vitest";
import { emptyPaymentFeedback, feedbackMessage, paymentFeedback, paymentReturnNotice } from "./feedback";

describe("payment feedback", () => {
  it("preserves a supplier rejection while refreshing the ledger after the failed action", () => {
    const rejected = paymentFeedback(emptyPaymentFeedback, { type: "action_failed", message: "Supplier price differs from the client-confirmed price." });
    expect(feedbackMessage(paymentFeedback(rejected, { type: "records_loaded" }))).toBe("Supplier price differs from the client-confirmed price.");
  });

  it("keeps an action rejection and a separate refresh failure visible", () => {
    const rejected = paymentFeedback(emptyPaymentFeedback, { type: "action_failed", message: "This version was replaced." });
    const offline = paymentFeedback(rejected, { type: "records_failed", message: "Payment records could not be loaded." });
    expect(feedbackMessage(offline)).toBe("This version was replaced. Payment records could not be loaded.");
    expect(feedbackMessage(paymentFeedback(offline, { type: "records_loaded" }))).toBe("This version was replaced.");
    expect(paymentFeedback(offline, { type: "action_started" })).toEqual(emptyPaymentFeedback);
  });

  it("treats a saved success return URL as navigation context instead of proof that money is still held", () => {
    const notice = paymentReturnNotice("authorized");
    expect(notice?.tone).toBe("warn");
    expect(notice?.text).toBe("Checkout return received. Check the current payment records below for held, captured, refunded and released amounts.");
    expect(paymentReturnNotice("failed")?.text).not.toMatch(/nothing is held|no money/i);
    expect(paymentReturnNotice(null)).toBeNull();
    expect(paymentReturnNotice("unrecognized")).toBeNull();
  });
});
