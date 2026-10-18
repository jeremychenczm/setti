/**
 * P3: capture MORE than was authorized. PayPal (US) documents an allowance of
 * 15% or $75, whichever is less. Uses two fresh authorizations: one captured
 * at exactly the allowance, one at the allowance plus one cent.
 * Question: can a small surcharge be captured without a new checkout?
 *
 *   npx tsx probes/p3-over-capture.ts --within wallet-b --beyond wallet-c
 */
import { overCaptureAllowance } from "../src/money/limits";
import { arg, run } from "./lib/cli";
import { FULL, payments, requestId, usd } from "./lib/paypal";
import { Recorder } from "./lib/record";
import { findAuthorization, loadState, saveState } from "./lib/state";

run(async () => {
  const state = loadState();
  const within = findAuthorization(state, arg("within"));
  const beyond = findAuthorization(state, arg("beyond"));
  const rec = new Recorder(`p3-over-capture-${within.label}-${beyond.label}`);

  const withinCents = within.amountCents + overCaptureAllowance(within.amountCents);
  const beyondCents = beyond.amountCents + overCaptureAllowance(beyond.amountCents) + 1;

  await rec.step(
    "capture at authorized amount + allowance",
    { authorizationId: within.authorizationId, authorizedCents: within.amountCents, captureCents: withinCents },
    () =>
      payments.captureAuthorizedPayment({
        authorizationId: within.authorizationId,
        prefer: FULL,
        paypalRequestId: requestId("p3", "within", within.label),
        body: { amount: usd(withinCents), finalCapture: true },
      }),
  );

  await rec.step(
    "capture at allowance + 1 cent (expect rejection)",
    { authorizationId: beyond.authorizationId, authorizedCents: beyond.amountCents, captureCents: beyondCents },
    () =>
      payments.captureAuthorizedPayment({
        authorizationId: beyond.authorizationId,
        prefer: FULL,
        paypalRequestId: requestId("p3", "beyond", beyond.label),
        body: { amount: usd(beyondCents), finalCapture: true },
      }),
  );

  await rec.step("read beyond authorization afterwards", { authorizationId: beyond.authorizationId }, () =>
    payments.getAuthorizedPayment({ authorizationId: beyond.authorizationId }),
  );

  within.usedBy = "p3";
  beyond.usedBy = "p3";
  saveState(state);
  rec.note(
    `Allowance used: ${withinCents - within.amountCents} cents on ${within.amountCents}; ` +
      `tried ${beyondCents - beyond.amountCents} cents on ${beyond.amountCents}. ` +
      "The second authorization stays open if the capture was rejected; void it or reuse it.",
  );
  rec.save();
});
