/**
 * P10: approve an order with a Sandbox test card from the server, with no buyer
 * on PayPal. Question: can an order created exactly as the app creates it (PayPal
 * wallet experience) be confirmed with a card, then authorized as usual? If not,
 * does an order created with the card as its payment source authorize instead?
 * The /try entry needs one of these to seed real holds without a buyer step.
 * The probe voids every hold it creates. On 2026-10-22 PayPal rejected
 * 4111111111111111 and 5555555555554444 with a bare 422; 4012000033330026 works.
 *
 *   npx tsx probes/p10-test-card-approval.ts [--card 4012000033330026]
 */
import { randomUUID } from "node:crypto";
import { CheckoutPaymentIntent, PaypalExperienceUserAction, PaypalWalletContextShippingPreference } from "@paypal/paypal-server-sdk";
import { arg, run } from "./lib/cli";
import { CANCEL_URL, FULL, RETURN_URL, firstAuthorization, orders, payments, requestId, usd } from "./lib/paypal";
import { Recorder } from "./lib/record";

const card = () => ({ number: arg("card", "4012000033330026"), expiry: "2030-12", securityCode: "123", name: "Setti Sandbox Test" });

run(async () => {
  const key = randomUUID().slice(0, 8);
  const rec = new Recorder("p10-test-card-approval");
  const unit = (step: string) => ({ referenceId: `p10-${step}`, amount: usd(12_300), customId: `p10-${step}-${key}`, invoiceId: `p10-${step}-${key}` });

  // A: the app's own order, then the card confirms it.
  const created = await rec.step("A create order as the app does", { amountCents: 12_300 }, () =>
    orders.createOrder({
      paypalRequestId: requestId("p10", "create-a", key),
      prefer: FULL,
      body: {
        intent: CheckoutPaymentIntent.Authorize,
        purchaseUnits: [unit("a")],
        paymentSource: { paypal: { experienceContext: { brandName: "Setti probe", returnUrl: RETURN_URL, cancelUrl: CANCEL_URL, userAction: PaypalExperienceUserAction.PayNow, shippingPreference: PaypalWalletContextShippingPreference.NoShipping } } },
      },
    }),
  );
  const confirmed = created?.id ? await rec.step("A confirm the order with a test card", { orderId: created.id, card: "[test card]" }, () =>
    orders.confirmOrder({ id: created.id!, prefer: FULL, body: { paymentSource: { card: card() } } }),
  ) : undefined;
  const authorizedA = confirmed?.status === "APPROVED" ? await rec.step("A authorize the confirmed order", { orderId: created!.id }, () =>
    orders.authorizeOrder({ id: created!.id!, paypalRequestId: requestId("p10", "authorize-a", key), prefer: FULL }),
  ) : undefined;
  rec.note(`A: created ${created?.status ?? "failed"}, after card confirm ${confirmed?.status ?? "failed"}, authorization ${firstAuthorization(authorizedA)?.status ?? "none"}.`);

  // B: the card is the order's payment source from the start.
  const direct = await rec.step("B create order with the card as payment source", { amountCents: 12_300, card: "[test card]" }, () =>
    orders.createOrder({
      paypalRequestId: requestId("p10", "create-b", key),
      prefer: FULL,
      body: { intent: CheckoutPaymentIntent.Authorize, purchaseUnits: [unit("b")], paymentSource: { card: card() } },
    }),
  );
  const authorizedB = direct?.status === "APPROVED" ? await rec.step("B authorize the card order", { orderId: direct.id }, () =>
    orders.authorizeOrder({ id: direct.id!, paypalRequestId: requestId("p10", "authorize-b", key), prefer: FULL }),
  ) : undefined;
  rec.note(`B: created ${direct?.status ?? "failed"}, authorization ${firstAuthorization(authorizedB ?? direct)?.status ?? "none"}.`);

  for (const [label, order] of [["A", authorizedA], ["B", authorizedB ?? direct]] as const) {
    const id = firstAuthorization(order)?.id;
    if (!id) continue;
    await rec.step(`${label} read the authorization`, { authorizationId: id }, () => payments.getAuthorizedPayment({ authorizationId: id }));
    await rec.step(`${label} void the probe hold`, { authorizationId: id }, () =>
      payments.voidPayment({ authorizationId: id, paypalRequestId: requestId("p10", `void-${label}`, key), prefer: FULL }),
    );
  }
  rec.save();
});
