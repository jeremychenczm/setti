/**
 * P8: does an AUTHORIZE order work when the buyer pays with Pay Later?
 * The buyer has to pick Pay Later on the PayPal approval page. The redirect
 * flow may not offer it in the sandbox; if so, record that and retest later
 * through the JavaScript SDK buttons with Pay Later enabled.
 *
 *   npx tsx probes/p8-pay-later-authorize.ts [--amount 200]
 */
import {
  CheckoutPaymentIntent,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
} from "@paypal/paypal-server-sdk";
import { arg, run, waitForApproval } from "./lib/cli";
import {
  CANCEL_URL,
  FULL,
  RETURN_URL,
  firstAuthorization,
  linkHref,
  orders,
  requestId,
  usd,
} from "./lib/paypal";
import { Recorder } from "./lib/record";
import { loadState, saveState } from "./lib/state";

run(async () => {
  // Pay in 4 is offered roughly between $30 and $1,500 in the US.
  const amountCents = Math.round(Number(arg("amount", "200")) * 100);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const rec = new Recorder("p8-pay-later-authorize");
  const body = {
    intent: CheckoutPaymentIntent.Authorize,
    purchaseUnits: [{ amount: usd(amountCents), description: "Setti probe Pay Later hold", customId: `probe-p8-${stamp}` }],
    paymentSource: {
      paypal: {
        experienceContext: {
          brandName: "Setti Probe",
          returnUrl: RETURN_URL,
          cancelUrl: CANCEL_URL,
          userAction: PaypalExperienceUserAction.PayNow,
          shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
        },
      },
    },
  };

  const order = await rec.step("create AUTHORIZE order", body, () =>
    orders.createOrder({ body, prefer: FULL, paypalRequestId: requestId("p8", "create", stamp) }),
  );
  if (!order?.id) return void rec.save();

  await waitForApproval(
    "Open this link as the sandbox BUYER (US personal account). If a Pay Later / Pay in 4 option is shown, choose it; " +
      "otherwise note that it was not offered and approve with the wallet.\n" +
      linkHref(order.links, "payer-action", "approve"),
    async () => String((await orders.getOrder({ id: order.id! })).result.status) === "APPROVED",
  );

  const authorized = await rec.step("authorize order", { orderId: order.id }, () =>
    orders.authorizeOrder({ id: order.id!, prefer: FULL, paypalRequestId: requestId("p8", "authorize", stamp) }),
  );
  await rec.step("read order (funding details)", { orderId: order.id }, () => orders.getOrder({ id: order.id! }));

  const auth = firstAuthorization(authorized);
  if (auth?.id) {
    const state = loadState();
    state.authorizations.push({
      label: `paylater-${stamp}`,
      orderId: order.id,
      authorizationId: auth.id,
      amountCents,
      createdAt: auth.createTime ?? new Date().toISOString(),
      expiresAt: auth.expirationTime,
      source: "checkout",
    });
    saveState(state);
  }
  rec.note("Record in this file whether Pay Later was offered and chosen; the API response alone may not say.");
  rec.save();
});
