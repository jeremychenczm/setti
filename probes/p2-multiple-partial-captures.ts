/**
 * P2: several partial captures against one authorization, closed by a final
 * capture; then one more capture, which PayPal should reject.
 * Question: can one hold be captured piece by piece as vendors confirm items?
 *
 *   npx tsx probes/p2-multiple-partial-captures.ts --auth wallet-a
 */
import { arg, run } from "./lib/cli";
import { FULL, payments, requestId, usd } from "./lib/paypal";
import { Recorder } from "./lib/record";
import { findAuthorization, loadState, saveState } from "./lib/state";

run(async () => {
  const label = arg("auth");
  const state = loadState();
  const auth = findAuthorization(state, label);
  const rec = new Recorder(`p2-multiple-partial-captures-${label}`);

  const first = Math.floor(auth.amountCents * 0.3);
  const second = Math.floor(auth.amountCents * 0.3);
  const last = auth.amountCents - first - second;

  const capture = (step: string, cents: number, finalCapture: boolean) =>
    rec.step(step, { authorizationId: auth.authorizationId, amountCents: cents, finalCapture }, () =>
      payments.captureAuthorizedPayment({
        authorizationId: auth.authorizationId,
        prefer: FULL,
        paypalRequestId: requestId("p2", step.replace(/\s+/g, "-"), label),
        body: { amount: usd(cents), finalCapture },
      }),
    );
  const read = (step: string) =>
    rec.step(step, { authorizationId: auth.authorizationId }, () =>
      payments.getAuthorizedPayment({ authorizationId: auth.authorizationId }),
    );

  await capture("capture 1 of 3", first, false);
  await read("read after capture 1");
  await capture("capture 2 of 3", second, false);
  await read("read after capture 2");
  await capture("final capture", last, true);
  await read("read after final capture");
  await capture("capture after final (expect rejection)", 100, false);

  auth.usedBy = "p2";
  saveState(state);
  rec.note(`Captured ${first} + ${second} + ${last} cents of ${auth.amountCents}.`);
  rec.save();
});
