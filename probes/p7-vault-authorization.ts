/**
 * P7: merchant-initiated authorizations against the saved PayPal (vault),
 * with no buyer interaction. Creates two holds:
 * - "<label>": partially captured right away, then closed with a final capture;
 * - "<label>-aged": left untouched, so P4/P5 can test reauthorization on a
 *   vault-created hold once it is 4+ days old.
 * Question: does one-hold-per-item via the vault behave like a checkout hold?
 *
 *   npx tsx probes/p7-vault-authorization.ts --label vault-a [--amount 100]
 */
import {
  CheckoutPaymentIntent,
  PaymentInitiator,
  StoredPaymentSourceUsageType,
  UsagePattern,
} from "@paypal/paypal-server-sdk";
import { arg, run } from "./lib/cli";
import { FULL, firstAuthorization, orders, payments, requestId, usd } from "./lib/paypal";
import { Recorder } from "./lib/record";
import { loadState, saveState, type StandingAuthorization } from "./lib/state";

run(async () => {
  const label = arg("label");
  const amountCents = Math.round(Number(arg("amount", "100")) * 100);
  const state = loadState();
  if (!state.vaultTokenId) throw new Error("No vault token in probes/.state.json. Run P6 first.");
  const rec = new Recorder(`p7-vault-authorization-${label}`);

  async function vaultHold(holdLabel: string): Promise<StandingAuthorization | undefined> {
    const body = {
      intent: CheckoutPaymentIntent.Authorize,
      purchaseUnits: [
        { amount: usd(amountCents), description: `ROOM probe vault hold ${holdLabel}`, customId: `probe-p7-${holdLabel}` },
      ],
      paymentSource: {
        paypal: {
          vaultId: state.vaultTokenId,
          storedCredential: {
            paymentInitiator: PaymentInitiator.Merchant,
            usage: StoredPaymentSourceUsageType.Subsequent,
            usagePattern: UsagePattern.UnscheduledPostpaid,
          },
        },
      },
    };
    // A request id is mandatory for single-step orders that carry a vault id.
    const order = await rec.step(`create vault AUTHORIZE order (${holdLabel})`, body, () =>
      orders.createOrder({ body, prefer: FULL, paypalRequestId: requestId("p7", "create", holdLabel) }),
    );
    if (!order?.id) return undefined;

    let auth = firstAuthorization(order);
    if (!auth && order.status === "APPROVED") {
      rec.note(`Order ${order.id} came back APPROVED without an authorization; calling authorize explicitly.`);
      const authorized = await rec.step(`authorize vault order (${holdLabel})`, { orderId: order.id }, () =>
        orders.authorizeOrder({ id: order!.id!, prefer: FULL, paypalRequestId: requestId("p7", "authorize", holdLabel) }),
      );
      auth = firstAuthorization(authorized);
    }
    if (!auth?.id) {
      rec.note(`No authorization on order ${order.id} (status ${order.status}).`);
      return undefined;
    }
    const standing: StandingAuthorization = {
      label: holdLabel,
      orderId: order.id,
      authorizationId: auth.id,
      amountCents,
      createdAt: auth.createTime ?? new Date().toISOString(),
      expiresAt: auth.expirationTime,
      source: "vault",
    };
    state.authorizations.push(standing);
    saveState(state);
    rec.note(`Vault hold "${holdLabel}": ${auth.id}, status ${auth.status}, order status ${order.status}.`);
    return standing;
  }

  const now = await vaultHold(label);
  await vaultHold(`${label}-aged`);

  if (now) {
    const half = Math.floor(amountCents / 2);
    await rec.step("partial capture on vault hold (not final)", { authorizationId: now.authorizationId, captureCents: half }, () =>
      payments.captureAuthorizedPayment({
        authorizationId: now.authorizationId,
        prefer: FULL,
        paypalRequestId: requestId("p7", "capture-1", label),
        body: { amount: usd(half), finalCapture: false },
      }),
    );
    await rec.step(
      "final capture on vault hold",
      { authorizationId: now.authorizationId, captureCents: amountCents - half },
      () =>
        payments.captureAuthorizedPayment({
          authorizationId: now.authorizationId,
          prefer: FULL,
          paypalRequestId: requestId("p7", "capture-2", label),
          body: { amount: usd(amountCents - half), finalCapture: true },
        }),
    );
    await rec.step("read vault hold afterwards", { authorizationId: now.authorizationId }, () =>
      payments.getAuthorizedPayment({ authorizationId: now.authorizationId }),
    );
    now.usedBy = "p7";
    saveState(state);
  }
  rec.note(`Run P4 or P5 with --auth ${label}-aged once it is at least 3 days old.`);
  rec.save();
});
