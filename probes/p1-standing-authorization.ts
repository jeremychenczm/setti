/**
 * P1: create a "standing" authorization through buyer checkout and keep it
 * open, so later probes (partial captures, over-capture, reauthorization,
 * void) have a real hold to work on.
 *
 *   npx tsx probes/p1-standing-authorization.ts --label wallet-a [--amount 100]
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
import { loadState, updateState } from "./lib/state";

run(async () => {
  const label = arg("label");
  const amountCents = Math.round(Number(arg("amount", "100")) * 100);
  const state = loadState();
  if (state.authorizations.some((a) => a.label === label)) {
    throw new Error(`Label "${label}" already exists in probes/.state.json`);
  }

  const rec = new Recorder(`p1-standing-authorization-${label}`);
  const body = {
    intent: CheckoutPaymentIntent.Authorize,
    purchaseUnits: [
      { amount: usd(amountCents), description: `Setti probe hold ${label}`, customId: `probe-p1-${label}` },
    ],
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
    orders.createOrder({ body, prefer: FULL, paypalRequestId: requestId("p1", "create", label) }),
  );
  if (!order?.id) return void rec.save();

  const approve = linkHref(order.links, "payer-action", "approve");
  await waitForApproval(
    `Open this link, log in as the sandbox BUYER and approve:\n${approve}`,
    async () => String((await orders.getOrder({ id: order.id! })).result.status) === "APPROVED",
  );

  const authorized = await rec.step("authorize order", { orderId: order.id }, () =>
    orders.authorizeOrder({ id: order.id!, prefer: FULL, paypalRequestId: requestId("p1", "authorize", label) }),
  );
  const auth = firstAuthorization(authorized);
  if (auth?.id) {
    const saved = {
      label,
      orderId: order.id,
      authorizationId: auth.id,
      amountCents,
      createdAt: auth.createTime ?? new Date().toISOString(),
      expiresAt: auth.expirationTime,
      source: "checkout" as const,
    };
    updateState((s) => void s.authorizations.push(saved));
    rec.note(`Standing authorization "${label}" saved: ${auth.id}, status ${auth.status}, expires ${auth.expirationTime}`);
  }
  rec.save();
});
