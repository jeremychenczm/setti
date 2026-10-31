/**
 * P12: save a Sandbox test card in the vault, then hold with it without the buyer.
 * Questions:
 *   A. Can the app's own order (PayPal wallet experience) be confirmed with a card
 *      that is saved on success, then authorized as usual?
 *   B. If not, does an order with the card as its payment source save it?
 *   C. Can the saved card hold a new amount with no buyer step (merchant-initiated)?
 *   D. Does reading the order back return the saved card, so a lost answer is recoverable?
 *   E. Does PayPal allow capturing more than a card hold (the PayPal-wallet allowance)?
 *   F. What does the payment token say about the card (brand, last digits)?
 *   G. After deleting the token, is a hold with it refused? Is a second delete accepted?
 *      2026-10-31: refused (403 PERMISSION_DENIED) in two runs, accepted in a third,
 *      so the app stops using a removed method itself. A second delete answers 204.
 * The probe voids every hold it leaves open.
 *
 *   npx tsx probes/p12-card-vault.ts
 */
import { randomUUID } from "node:crypto";
import {
  CheckoutPaymentIntent, PaymentInitiator, PaypalExperienceUserAction, PaypalWalletContextShippingPreference,
  StoreInVaultInstruction, StoredPaymentSourcePaymentType, StoredPaymentSourceUsageType, type Order, type OrderAuthorizeResponse,
} from "@paypal/paypal-server-sdk";
import { run } from "./lib/cli";
import { CANCEL_URL, FULL, RETURN_URL, firstAuthorization, orders, payments, requestId, usd, vault } from "./lib/paypal";
import { Recorder } from "./lib/record";

const card = { number: "4012000033330026", expiry: "2030-12", securityCode: "123", name: "Setti Sandbox Test" };
const saveOnSuccess = { vault: { storeInVault: StoreInVaultInstruction.OnSuccess } };

function savedCard(order: Order | OrderAuthorizeResponse | undefined) {
  return order?.paymentSource?.card;
}

run(async () => {
  const key = randomUUID().slice(0, 8);
  const rec = new Recorder("p12-card-vault");
  const unit = (step: string, cents: number) => ({ referenceId: `p12-${step}`, amount: usd(cents), customId: `p12-${step}-${key}`, invoiceId: `p12-${step}-${key}` });
  const holds: string[] = [];

  // A: the app's own checkout order, confirmed with a card that is saved on success.
  const created = await rec.step("A create order as the app does", { amountCents: 12_300 }, () =>
    orders.createOrder({
      paypalRequestId: requestId("p12", "create-a", key), prefer: FULL,
      body: {
        intent: CheckoutPaymentIntent.Authorize, purchaseUnits: [unit("a", 12_300)],
        paymentSource: { paypal: { experienceContext: { brandName: "Setti probe", returnUrl: RETURN_URL, cancelUrl: CANCEL_URL, userAction: PaypalExperienceUserAction.PayNow, shippingPreference: PaypalWalletContextShippingPreference.NoShipping } } },
      },
    }),
  );
  const confirmed = created?.id ? await rec.step("A confirm with the test card, saved on success", { orderId: created.id, card: "[test card]" }, () =>
    orders.confirmOrder({ id: created.id!, prefer: FULL, body: { paymentSource: { card: { ...card, attributes: saveOnSuccess } } } }),
  ) : undefined;
  const authorizedA = confirmed?.status === "APPROVED" ? await rec.step("A authorize the confirmed order", { orderId: created!.id }, () =>
    orders.authorizeOrder({ id: created!.id!, paypalRequestId: requestId("p12", "authorize-a", key), prefer: FULL }),
  ) : undefined;
  const vaultA = savedCard(authorizedA)?.attributes?.vault;
  rec.scrub(vaultA?.id); rec.scrub(vaultA?.customer?.id);
  if (firstAuthorization(authorizedA)?.id) holds.push(firstAuthorization(authorizedA)!.id!);
  rec.note(`A: confirm ${confirmed?.status ?? "failed"}, authorization ${firstAuthorization(authorizedA)?.status ?? "none"}, vault ${vaultA?.status ?? "none"}${vaultA?.id ? " (token returned)" : ""}.`);

  // B: the card as the order's payment source from the start, saved on success.
  let tokenId = vaultA?.id;
  if (!tokenId) {
    const direct = await rec.step("B create order with the card, saved on success", { amountCents: 12_300, card: "[test card]" }, () =>
      orders.createOrder({
        paypalRequestId: requestId("p12", "create-b", key), prefer: FULL,
        body: { intent: CheckoutPaymentIntent.Authorize, purchaseUnits: [unit("b", 12_300)], paymentSource: { card: { ...card, attributes: saveOnSuccess } } },
      }),
    );
    const vaultB = savedCard(direct)?.attributes?.vault;
    rec.scrub(vaultB?.id); rec.scrub(vaultB?.customer?.id);
    if (firstAuthorization(direct)?.id) holds.push(firstAuthorization(direct)!.id!);
    tokenId = vaultB?.id;
    rec.note(`B: order ${direct?.status ?? "failed"}, authorization ${firstAuthorization(direct)?.status ?? "none"}, vault ${vaultB?.status ?? "none"}${vaultB?.id ? " (token returned)" : ""}.`);
  }

  // D: the saved card on read-back, for recovering a lost authorize answer.
  if (created?.id) {
    const reread = await rec.step("D read order A back", { orderId: created.id }, () => orders.getOrder({ id: created.id! }));
    rec.note(`D: read-back vault ${savedCard(reread)?.attributes?.vault?.status ?? "none"}${savedCard(reread)?.attributes?.vault?.id ? " with token" : " without token"}, card ${savedCard(reread)?.brand ?? "?"} ${savedCard(reread)?.lastDigits ?? "?"}.`);
  }
  if (!tokenId) { rec.note("No card token was saved; C, E, F and G were skipped."); return finish(); }

  // C: a merchant-initiated hold with the saved card, no buyer.
  const held = await rec.step("C hold $100.00 with the saved card", { amountCents: 10_000, vaultId: "[token]" }, () =>
    orders.createOrder({
      paypalRequestId: requestId("p12", "create-c", key), prefer: FULL,
      body: {
        intent: CheckoutPaymentIntent.Authorize, purchaseUnits: [unit("c", 10_000)],
        paymentSource: { card: { vaultId: tokenId!, storedCredential: { paymentInitiator: PaymentInitiator.Merchant, paymentType: StoredPaymentSourcePaymentType.Unscheduled, usage: StoredPaymentSourceUsageType.Subsequent } } },
      },
    }),
  );
  const holdC = firstAuthorization(held);
  rec.note(`C: order ${held?.status ?? "failed"}, authorization ${holdC?.status ?? "none"}${held?.links?.some((link) => link.rel === "payer-action") ? ", payer action requested" : ""}.`);

  // E: capture more than the card hold, within the PayPal-wallet allowance (115%, at most +$75).
  if (holdC?.id) {
    const over = await rec.step("E capture $115.00 from the $100.00 card hold", { authorizationId: holdC.id, amountCents: 11_500 }, () =>
      payments.captureAuthorizedPayment({ authorizationId: holdC.id!, paypalRequestId: requestId("p12", "over-capture", key), prefer: FULL, body: { amount: usd(11_500), finalCapture: true } }),
    );
    rec.note(`E: over-capture ${over?.status ?? "refused"}.`);
    if (!over) holds.push(holdC.id);
  }

  // F: what the token says about the card.
  const token = await rec.step("F read the payment token", { id: "[token]" }, () => vault.getPaymentToken(tokenId!));
  rec.note(`F: token source ${token?.paymentSource?.card ? `card ${token.paymentSource.card.brand ?? "?"} ${token.paymentSource.card.lastDigits ?? "?"}` : "unreadable"}.`);

  // G: delete the token, then try to hold with it.
  await rec.step("G delete the payment token", { id: "[token]" }, () => vault.deletePaymentToken(tokenId!));
  const refused = await rec.step("G hold with the deleted token", { amountCents: 5_000, vaultId: "[token]" }, () =>
    orders.createOrder({
      paypalRequestId: requestId("p12", "create-g", key), prefer: FULL,
      body: {
        intent: CheckoutPaymentIntent.Authorize, purchaseUnits: [unit("g", 5_000)],
        paymentSource: { card: { vaultId: tokenId!, storedCredential: { paymentInitiator: PaymentInitiator.Merchant, paymentType: StoredPaymentSourcePaymentType.Unscheduled, usage: StoredPaymentSourceUsageType.Subsequent } } },
      },
    }),
  );
  if (firstAuthorization(refused)?.id) holds.push(firstAuthorization(refused)!.id!);
  rec.note(`G: hold after delete ${refused ? `${refused.status} (not refused)` : "refused"}.`);
  // A retry whose first answer was lost deletes the token again: what does PayPal say then?
  await rec.step("G delete the payment token again", { id: "[token]" }, () => vault.deletePaymentToken(tokenId!));
  // A delete answers 204 with no body, so the recorded step says whether PayPal accepted it.
  rec.note(`G: second delete ${rec.steps.at(-1)?.ok ? `accepted (${rec.steps.at(-1)?.statusCode})` : `refused (${rec.steps.at(-1)?.statusCode})`}.`);
  return finish();

  async function finish() {
    for (const id of holds) {
      await rec.step("void a probe hold", { authorizationId: id }, () =>
        payments.voidPayment({ authorizationId: id, paypalRequestId: requestId("p12", `void-${id}`, key), prefer: FULL }),
      );
    }
    rec.save();
  }
});
