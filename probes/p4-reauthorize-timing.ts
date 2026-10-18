/**
 * P4: reauthorization timing.
 * - Younger than 3 days: reauthorize should be rejected (still in the honor period).
 * - Day 4 to 29: reauthorize once; compare the new authorization's expiry with
 *   the original's (expected: unchanged), then try a second reauthorization
 *   on both IDs (expected: rejected).
 *
 *   npx tsx probes/p4-reauthorize-timing.ts --auth wallet-d
 */
import { arg, run } from "./lib/cli";
import { FULL, payments, requestId, usd } from "./lib/paypal";
import { Recorder } from "./lib/record";
import { ageInDays, findAuthorization, loadState, saveState } from "./lib/state";

run(async () => {
  const label = arg("auth");
  const state = loadState();
  const auth = findAuthorization(state, label);
  const age = ageInDays(auth);
  const rec = new Recorder(`p4-reauthorize-timing-${label}`);
  rec.note(`Authorization age: ${age.toFixed(2)} days.`);

  const reauthorize = (step: string, authorizationId: string) =>
    rec.step(step, { authorizationId, amountCents: auth.amountCents }, () =>
      payments.reauthorizePayment({
        authorizationId,
        prefer: FULL,
        paypalRequestId: requestId("p4", step.replace(/\s+/g, "-"), label),
        body: { amount: usd(auth.amountCents) },
      }),
    );

  if (age < 3) {
    await reauthorize("reauthorize inside honor period (expect rejection)", auth.authorizationId);
    rec.note("Re-run this probe once the authorization is at least 3 days old.");
    return void rec.save();
  }

  const before = await rec.step("read original authorization", { authorizationId: auth.authorizationId }, () =>
    payments.getAuthorizedPayment({ authorizationId: auth.authorizationId }),
  );
  const fresh = await reauthorize("reauthorize once", auth.authorizationId);
  if (fresh?.id) {
    auth.reauthorizedId = fresh.id;
    saveState(state);
    rec.note(
      `New authorization ${fresh.id}. Original expiry ${before?.expirationTime}, new expiry ${fresh.expirationTime}.`,
    );
    await reauthorize("second reauthorize on new id (expect rejection)", fresh.id);
  }
  await reauthorize("second reauthorize on original id (expect rejection)", auth.authorizationId);
  await rec.step("read original authorization afterwards", { authorizationId: auth.authorizationId }, () =>
    payments.getAuthorizedPayment({ authorizationId: auth.authorizationId }),
  );
  rec.save();
});
