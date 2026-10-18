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
import { run, waitForApproval } from "./lib/cli";
import { CANCEL_URL, RETURN_URL, linkHref, requestId, vault } from "./lib/paypal";
import { Recorder } from "./lib/record";
import { updateState } from "./lib/state";

run(async () => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const rec = new Recorder("p6-vault-setup");

  const body = {
    paymentSource: {
      paypal: {
        description: "Setti probe: save PayPal for this project",
        usageType: PaypalPaymentTokenUsageType.Merchant,
        usagePattern: UsagePattern.UnscheduledPostpaid,
        permitMultiplePaymentTokens: true,
        experienceContext: {
          brandName: "Setti Probe",
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

  await waitForApproval(
    `Open this link, log in as the sandbox BUYER and agree to save PayPal:\n${linkHref(setup.links, "approve")}`,
    async () => String((await vault.getSetupToken(setup.id!)).result.status) === "APPROVED",
  );

  const tokenBody = { paymentSource: { token: { id: setup.id, type: VaultTokenRequestType.SetupToken } } };
  const token = await rec.step("exchange setup token for payment token", tokenBody, () =>
    vault.createPaymentToken({ body: tokenBody, paypalRequestId: requestId("p6", "token", stamp) }),
  );
  if (token?.id) {
    const tokenId = token.id;
    rec.scrub(tokenId);
    updateState((s) => {
      s.vaultTokenId = tokenId;
    });
    rec.note("Vault payment token saved to probes/.state.json (kept out of this recording).");
  }
  rec.save();
});
