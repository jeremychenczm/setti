/**
 * P5: capture part of an authorization, then reauthorize what is left.
 * Question: once one item on a shared hold has been captured, can the rest
 * of the hold still be extended past the honor period?
 * Needs an authorization that is at least 3 days old (pass --force to try anyway).
 *
 *   npx tsx probes/p5-reauthorize-after-partial.ts --auth wallet-e
 */
import { arg, flag, run } from "./lib/cli";
import { FULL, payments, requestId, usd } from "./lib/paypal";
import { Recorder } from "./lib/record";
import { ageInDays, findAuthorization, loadState, saveState } from "./lib/state";

run(async () => {
  const label = arg("auth");
  const state = loadState();
  const auth = findAuthorization(state, label);
  const age = ageInDays(auth);
  if (age < 3 && !flag("force")) {
    throw new Error(`"${label}" is ${age.toFixed(2)} days old; wait until day 4 or pass --force.`);
  }

  const rec = new Recorder(`p5-reauthorize-after-partial-${label}`);
  const captured = Math.floor(auth.amountCents * 0.4);
  const remaining = auth.amountCents - captured;
  rec.note(`Authorization age: ${age.toFixed(2)} days.`);

  await rec.step("partial capture (not final)", { authorizationId: auth.authorizationId, captureCents: captured }, () =>
    payments.captureAuthorizedPayment({
      authorizationId: auth.authorizationId,
      prefer: FULL,
      paypalRequestId: requestId("p5", "capture", label),
      body: { amount: usd(captured), finalCapture: false },
    }),
  );
  await rec.step("read after partial capture", { authorizationId: auth.authorizationId }, () =>
    payments.getAuthorizedPayment({ authorizationId: auth.authorizationId }),
  );
  const fresh = await rec.step(
    "reauthorize the remaining amount",
    { authorizationId: auth.authorizationId, amountCents: remaining },
    () =>
      payments.reauthorizePayment({
        authorizationId: auth.authorizationId,
        prefer: FULL,
        paypalRequestId: requestId("p5", "reauthorize", label),
        body: { amount: usd(remaining) },
      }),
  );
  if (fresh?.id) {
    auth.reauthorizedId = fresh.id;
    rec.note(`Reauthorized as ${fresh.id}, status ${fresh.status}, expires ${fresh.expirationTime}.`);
  }
  auth.usedBy = "p5";
  saveState(state);
  rec.save();
});
