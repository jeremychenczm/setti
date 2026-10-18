/**
 * P9: capture part of an authorization, then void the rest, and read the
 * authorization back. Question: after a void, does PayPal report the original
 * amount or what was actually released? (The app must compute "released" itself
 * if PayPal keeps showing the original amount.)
 *
 *   npx tsx probes/p9-void-after-partial.ts --auth wallet-f
 */
import { arg, run } from "./lib/cli";
import { FULL, dollarsToCents, payments, requestId, usd } from "./lib/paypal";
import { Recorder } from "./lib/record";
import { findAuthorization, loadState, saveState } from "./lib/state";

run(async () => {
  const label = arg("auth");
  const state = loadState();
  const auth = findAuthorization(state, label);
  const rec = new Recorder(`p9-void-after-partial-${label}`);
  const captured = Math.floor(auth.amountCents * 0.4);

  await rec.step("partial capture (not final)", { authorizationId: auth.authorizationId, captureCents: captured }, () =>
    payments.captureAuthorizedPayment({
      authorizationId: auth.authorizationId,
      prefer: FULL,
      paypalRequestId: requestId("p9", "capture", label),
      body: { amount: usd(captured), finalCapture: false },
    }),
  );
  await rec.step("void the remainder", { authorizationId: auth.authorizationId }, () =>
    payments.voidPayment({
      authorizationId: auth.authorizationId,
      prefer: FULL,
      paypalRequestId: requestId("p9", "void", label),
    }),
  );
  const after = await rec.step("read authorization after void", { authorizationId: auth.authorizationId }, () =>
    payments.getAuthorizedPayment({ authorizationId: auth.authorizationId }),
  );

  auth.usedBy = "p9";
  saveState(state);
  rec.note(
    `Authorized ${auth.amountCents}, captured ${captured}, so ${auth.amountCents - captured} should be released. ` +
      `PayPal now reports amount ${dollarsToCents(after?.amount?.value)} and status ${after?.status}.`,
  );
  rec.save();
});
