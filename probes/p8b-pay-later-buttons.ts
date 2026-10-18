/**
 * P8b: Pay Later through the JS SDK buttons instead of the redirect page (P8
 * showed that the redirect page does not offer Pay Later in the sandbox).
 *
 * Serves a local page that loads the SDK twice (intent=authorize and
 * intent=capture), reports whether the Pay Later button is eligible for each,
 * and, when it is eligible for AUTHORIZE, lets the buyer approve an AUTHORIZE
 * order with Pay Later. Orders are created and authorized on this server; the
 * results are recorded like the other probes.
 *
 *   npx tsx probes/p8b-pay-later-buttons.ts [--port 4318] [--amount 200]
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import { arg, run } from "./lib/cli";
import { FULL, firstAuthorization, orders, requestId, usd } from "./lib/paypal";
import { Recorder } from "./lib/record";

const TIMEOUT_MS = 30 * 60_000;

run(async () => {
  const port = Number(arg("port", "4318"));
  const amountCents = Math.round(Number(arg("amount", "200")) * 100);
  const clientId = process.env.PAYPAL_CLIENT_ID ?? "";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const rec = new Recorder("p8b-pay-later-buttons");
  let orderCount = 0;

  const finish = (server: ReturnType<typeof createServer>) => {
    rec.save();
    setTimeout(() => server.close(() => process.exit(0)), 1_000);
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") return send(res, 200, page(clientId), "text/html");

      const body = req.method === "POST" ? await readJson(req) : {};

      if (req.url === "/api/eligibility") {
        const line = `Pay Later button eligible: intent=authorize ${body.authorize ? "yes" : "no"}, intent=capture ${body.capture ? "yes" : "no"}`;
        rec.note(line);
        if (!body.authorize) finish(server);
        return send(res, 200, { ok: true });
      }

      if (req.url === "/api/note") {
        rec.note(String(body.text ?? ""));
        return send(res, 200, { ok: true });
      }

      if (req.url === "/api/order") {
        orderCount += 1;
        const orderBody = {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [{ amount: usd(amountCents), description: "Setti probe Pay Later hold", customId: "probe-p8b" }],
        };
        const order = await rec.step(`create AUTHORIZE order #${orderCount}`, orderBody, () =>
          orders.createOrder({
            body: orderBody,
            prefer: FULL,
            paypalRequestId: requestId("p8b", "create", `${stamp}-${orderCount}`),
          }),
        );
        return send(res, order?.id ? 200 : 502, { id: order?.id });
      }

      if (req.url === "/api/authorize") {
        const id = String(body.orderID ?? "");
        const authorized = await rec.step("authorize order (buyer chose the Pay Later button)", { orderId: id }, () =>
          orders.authorizeOrder({ id, prefer: FULL, paypalRequestId: requestId("p8b", "authorize", id) }),
        );
        const order = await rec.step("read order (funding details)", { orderId: id }, () => orders.getOrder({ id }));
        const auth = firstAuthorization(authorized);
        const summary = {
          authorized: Boolean(auth?.id),
          authorizationStatus: auth?.status,
          amount: auth?.amount,
          expiresAt: auth?.expirationTime,
          paymentSource: Object.keys(order?.paymentSource ?? {}),
        };
        rec.note(`Pay Later + AUTHORIZE result: ${JSON.stringify(summary)}`);
        send(res, 200, summary);
        return finish(server);
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, () => {
    console.log(`Open http://localhost:${port} in the browser and follow the page.`);
  });
  setTimeout(() => {
    rec.note("Timed out before the buyer finished.");
    finish(server);
  }, TIMEOUT_MS).unref();
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
  const sdk = (intent: string, namespace: string) =>
    `<script src="https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}` +
    `&currency=USD&intent=${intent}&enable-funding=paylater&buyer-country=US&components=buttons"` +
    ` data-namespace="${namespace}"></script>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Setti probe P8b</title>
<style>body{font-family:system-ui,sans-serif;margin:40px auto;max-width:560px;line-height:1.5}pre{background:#f4f4f5;padding:12px}</style>
</head>
<body>
<h1>Pay Later with AUTHORIZE</h1>
<p id="eligibility">Checking which buttons PayPal offers...</p>
<p>If a Pay Later button appears below, click it, log in as the sandbox <b>personal</b> buyer and finish the Pay Later flow.</p>
<div id="paylater"></div>
<pre id="out"></pre>
${sdk("authorize", "paypalAuth")}
${sdk("capture", "paypalCapture")}
<script>
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const show = (value) => { document.getElementById("out").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); };
window.addEventListener("load", async () => {
  const authorizeButton = paypalAuth.Buttons({
    fundingSource: paypalAuth.FUNDING.PAYLATER,
    createOrder: async () => (await post("/api/order", {})).id,
    onApprove: async (data) => show(await post("/api/authorize", { orderID: data.orderID })),
    onCancel: () => show("The buyer closed the Pay Later window. Click the button again to retry."),
    onError: (err) => { show("SDK error: " + err); post("/api/note", { text: "SDK error: " + String(err) }); },
  });
  const captureButton = paypalCapture.Buttons({ fundingSource: paypalCapture.FUNDING.PAYLATER });
  const eligible = { authorize: authorizeButton.isEligible(), capture: captureButton.isEligible() };
  document.getElementById("eligibility").textContent =
    "Pay Later button offered with intent=authorize: " + (eligible.authorize ? "yes" : "no") +
    "; with intent=capture: " + (eligible.capture ? "yes" : "no") + ".";
  await post("/api/eligibility", eligible);
  if (eligible.authorize) authorizeButton.render("#paylater");
  else show("PayPal does not offer the Pay Later button for AUTHORIZE orders here. The result is recorded; you can close this page.");
});
</script>
</body>
</html>`;
}
