/**
 * P11: can a buyer who pays with Pay Later also save PayPal for later holds?
 *
 * Serves a local page with two JS SDK buttons, PayPal and Pay Later. Each
 * creates the same AUTHORIZE order that asks PayPal to save the wallet on
 * success (attributes.vault.store_in_vault = ON_SUCCESS). After the buyer
 * approves, this server authorizes the order and checks whether PayPal returned
 * a vault token. When it did, it creates a second hold from that token with no
 * buyer interaction, as Setti's per-item holds would. Every hold made here is
 * voided at the end, so the sandbox keeps no open holds.
 *
 *   npx tsx probes/p11-pay-later-vault.ts [--port 4319] [--amount 200] [--follow-up 50]
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CheckoutPaymentIntent,
  PaymentInitiator,
  PaypalExperienceUserAction,
  PaypalPaymentTokenUsageType,
  PaypalWalletContextShippingPreference,
  StoredPaymentSourceUsageType,
  StoreInVaultInstruction,
  UsagePattern,
} from "@paypal/paypal-server-sdk";
import { arg, run } from "./lib/cli";
import { CANCEL_URL, FULL, RETURN_URL, firstAuthorization, orders, payments, requestId, usd } from "./lib/paypal";
import { Recorder } from "./lib/record";

const TIMEOUT_MS = 30 * 60_000;
type Funding = "paypal" | "paylater";

run(async () => {
  const port = Number(arg("port", "4319"));
  const amountCents = Math.round(Number(arg("amount", "200")) * 100);
  const followUpCents = Math.round(Number(arg("follow-up", "50")) * 100);
  const clientId = process.env.PAYPAL_CLIENT_ID ?? "";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const rec = new Recorder("p11-pay-later-vault");
  const holds: string[] = [];
  const done = new Set<Funding>();
  let finished = false;

  async function finish(server: ReturnType<typeof createServer>, reason: string) {
    if (finished) return;
    finished = true;
    rec.note(reason);
    for (const id of holds) {
      await rec.step(`void hold ${holds.indexOf(id) + 1} (cleanup)`, { authorizationId: id }, () =>
        payments.voidPayment({ authorizationId: id, prefer: FULL, paypalRequestId: requestId("p11", "void", id) }),
      );
    }
    rec.save();
    setTimeout(() => server.close(() => process.exit(0)), 1_000);
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") return send(res, 200, page(clientId), "text/html");
      const body = req.method === "POST" ? await readJson(req) : {};

      if (req.url === "/api/eligibility") {
        rec.note(`Buttons eligible with intent=authorize: PayPal ${body.paypal ? "yes" : "no"}, Pay Later ${body.paylater ? "yes" : "no"}`);
        return send(res, 200, { ok: true });
      }

      if (req.url === "/api/note") {
        rec.note(String(body.text ?? ""));
        return send(res, 200, { ok: true });
      }

      if (req.url === "/api/order") {
        const funding = body.funding as Funding;
        const orderBody = {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [{ amount: usd(amountCents), description: `Setti probe save PayPal with ${funding}`, customId: `probe-p11-${funding}` }],
          paymentSource: {
            paypal: {
              attributes: {
                vault: {
                  storeInVault: StoreInVaultInstruction.OnSuccess,
                  usageType: PaypalPaymentTokenUsageType.Merchant,
                  usagePattern: UsagePattern.UnscheduledPostpaid,
                  permitMultiplePaymentTokens: true,
                  description: "Setti probe: save PayPal for this project",
                },
              },
              experienceContext: {
                brandName: "Setti Probe",
                returnUrl: RETURN_URL,
                cancelUrl: CANCEL_URL,
                shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
                userAction: PaypalExperienceUserAction.PayNow,
              },
            },
          },
        };
        const order = await rec.step(`create AUTHORIZE order that saves PayPal (${funding} button)`, orderBody, () =>
          orders.createOrder({ body: orderBody, prefer: FULL, paypalRequestId: requestId("p11", "create", `${stamp}-${funding}`) }),
        );
        return send(res, order?.id ? 200 : 502, { id: order?.id });
      }

      if (req.url === "/api/authorize") {
        const funding = body.funding as Funding;
        const id = String(body.orderID ?? "");
        const authorized = await rec.step(`authorize order (${funding} button)`, { orderId: id }, () =>
          orders.authorizeOrder({ id, prefer: FULL, paypalRequestId: requestId("p11", "authorize", id) }),
        );
        const auth = firstAuthorization(authorized);
        if (auth?.id) holds.push(auth.id);
        const saved = authorized?.paymentSource?.paypal?.attributes?.vault;
        if (saved?.id) rec.scrub(saved.id);
        if (saved?.customer?.id) rec.scrub(saved.customer.id);
        const summary: Record<string, unknown> = {
          button: funding,
          authorized: Boolean(auth?.id),
          authorizationStatus: auth?.status,
          vaultStatus: saved?.status ?? "none returned",
          vaultTokenReturned: Boolean(saved?.id),
        };

        if (saved?.id) {
          const followBody = {
            intent: CheckoutPaymentIntent.Authorize,
            purchaseUnits: [{ amount: usd(followUpCents), description: `Setti probe follow-up hold from the ${funding} token`, customId: `probe-p11-${funding}-follow` }],
            paymentSource: {
              paypal: {
                vaultId: saved.id,
                storedCredential: {
                  paymentInitiator: PaymentInitiator.Merchant,
                  usage: StoredPaymentSourceUsageType.Subsequent,
                  usagePattern: UsagePattern.UnscheduledPostpaid,
                },
              },
            },
          };
          const follow = await rec.step(`create follow-up hold from the saved token (${funding}), no buyer`, followBody, () =>
            orders.createOrder({ body: followBody, prefer: FULL, paypalRequestId: requestId("p11", "follow", `${stamp}-${funding}`) }),
          );
          const followAuth = firstAuthorization(follow);
          if (followAuth?.id) holds.push(followAuth.id);
          summary.followUpOrderStatus = follow?.status ?? "failed";
          summary.followUpHold = followAuth?.status ?? "none";
        }

        rec.note(`${funding} result: ${JSON.stringify(summary)}`);
        done.add(funding);
        send(res, 200, summary);
        if (done.size === 2) void finish(server, "Both buttons tested.");
        return;
      }

      if (req.url === "/api/finish") {
        send(res, 200, { ok: true });
        return void finish(server, "The tester finished the probe.");
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, () => {
    console.log(`Open http://localhost:${port} in the browser and follow the page.`);
  });
  setTimeout(() => void finish(server, "Timed out before the tester finished."), TIMEOUT_MS).unref();
});

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8` });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function page(clientId: string): string {
  const sdk = `<script src="https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}` +
    `&currency=USD&intent=authorize&enable-funding=paylater&buyer-country=US&components=buttons" data-namespace="paypalSdk"></script>`;
  // Without a namespace the SDK's default global failed to initialise in Chrome on 2026-10-22 (a Venmo experiment threw).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Setti probe P11</title>
<style>body{font-family:system-ui,sans-serif;margin:40px auto;max-width:600px;line-height:1.5}pre{background:#f4f4f5;padding:12px;white-space:pre-wrap}.slot{margin:16px 0}</style>
</head>
<body>
<h1>Pay Later + save PayPal</h1>
<p id="eligibility">Checking which buttons PayPal offers...</p>
<p>Test the <b>Pay Later</b> button first, then the <b>PayPal</b> button. For each one, log in as the sandbox <b>personal</b> buyer and finish the flow, agreeing to save PayPal if asked. Every hold is voided when the probe ends.</p>
<h2>1. Pay Later</h2><div class="slot" id="paylater"></div>
<h2>2. PayPal (control)</h2><div class="slot" id="paypal"></div>
<pre id="out"></pre>
<button id="finish">Finish (void holds and save the recording)</button>
${sdk}
<script>
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const out = document.getElementById("out");
const show = (label, value) => { out.textContent += label + ": " + (typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\\n\\n"; };
const button = (funding, source) => paypalSdk.Buttons({
  fundingSource: source,
  createOrder: async () => (await post("/api/order", { funding })).id,
  onApprove: async (data) => show(funding, await post("/api/authorize", { funding, orderID: data.orderID })),
  onCancel: () => show(funding, "The buyer closed the window. Click the button again to retry."),
  onError: (err) => { show(funding, "SDK error: " + err); post("/api/note", { text: funding + " SDK error: " + String(err) }); },
});
window.addEventListener("load", async () => {
  const buttons = { paylater: button("paylater", paypalSdk.FUNDING.PAYLATER), paypal: button("paypal", paypalSdk.FUNDING.PAYPAL) };
  const eligible = { paylater: buttons.paylater.isEligible(), paypal: buttons.paypal.isEligible() };
  document.getElementById("eligibility").textContent = "Offered with intent=authorize: Pay Later " + (eligible.paylater ? "yes" : "no") + ", PayPal " + (eligible.paypal ? "yes" : "no") + ".";
  await post("/api/eligibility", eligible);
  for (const funding of ["paylater", "paypal"]) {
    if (eligible[funding]) buttons[funding].render("#" + funding);
    else document.getElementById(funding).textContent = "Not offered here.";
  }
  document.getElementById("finish").onclick = async () => { await post("/api/finish", {}); show("probe", "Finished. You can close this page."); };
});
</script>
</body>
</html>`;
}
