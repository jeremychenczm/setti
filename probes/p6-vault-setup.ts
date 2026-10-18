/**
 * P6: save the buyer's PayPal wallet without a purchase (vault).
 * setup token -> buyer approves once -> payment token (the vault id that
 * later lets the studio create holds and charges without a new checkout).
 *
 *   npx tsx probes/p6-vault-setup.ts
 */
import {
  ExperienceContextShippingPreference,
  PaypalPaymentTokenUsageType,
  UsagePattern,
  VaultTokenRequestType,
  VaultUserAction,
} from "@paypal/paypal-server-sdk";
import { run, waitForEnter } from "./lib/cli";
import { CANCEL_URL, RETURN_URL, linkHref, requestId, vault } from "./lib/paypal";
import { Recorder } from "./lib/record";
import { loadState, saveState } from "./lib/state";

run(async () => {
  const state = loadState();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const rec = new Recorder("p6-vault-setup");

  const body = {
    paymentSource: {
      paypal: {
        description: "ROOM probe: save PayPal for this project",
        usageType: PaypalPaymentTokenUsageType.Merchant,
        usagePattern: UsagePattern.UnscheduledPostpaid,
        permitMultiplePaymentTokens: true,
        experienceContext: {
          brandName: "ROOM Probe",
          returnUrl: RETURN_URL,
          cancelUrl: CANCEL_URL,
          shippingPreference: ExperienceContextShippingPreference.NoShipping,
          userAction: VaultUserAction.Continue,
        },
      },
    },
  };

  const setup = await rec.step("create setup token", body, () =>
    vault.createSetupToken({ body, paypalRequestId: requestId("p6", "setup", stamp) }),
  );
  if (!setup?.id) return void rec.save();

  await waitForEnter(
    `Open this link, log in as the sandbox BUYER and agree to save PayPal:\n${linkHref(setup.links, "approve")}`,
  );

  const tokenBody = { paymentSource: { token: { id: setup.id, type: VaultTokenRequestType.SetupToken } } };
  const token = await rec.step("exchange setup token for payment token", tokenBody, () =>
    vault.createPaymentToken({ body: tokenBody, paypalRequestId: requestId("p6", "token", stamp) }),
  );
  if (token?.id) {
    state.vaultTokenId = token.id;
    saveState(state);
    rec.note(`Vault payment token saved to probes/.state.json (${token.id.slice(0, 4)}...).`);
  }
  rec.save();
});
