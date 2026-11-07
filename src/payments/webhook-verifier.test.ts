import { afterEach, describe, expect, it, vi } from "vitest";
import { paypalWebhookVerifier } from "./webhook";

const sandbox: NodeJS.ProcessEnv = {
  NODE_ENV: "test", PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "client-id", PAYPAL_CLIENT_SECRET: "client-secret", PAYPAL_WEBHOOK_ID: "WH-ID-1",
};
const event = { id: "WH-EVENT-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPTURE-1" } };
const headers = new Headers({
  "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "T-1", "paypal-transmission-sig": "SIG-1", "paypal-transmission-time": "2026-11-07T20:00:00Z",
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Stands in for PayPal: one answer for the access token, one for the signature check. */
function paypalAnswers(token: () => Promise<Response>, verdict: () => Promise<Response>) {
  const fetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
    (url) => String(url).endsWith("/v1/oauth2/token") ? token() : verdict());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const verify = () => paypalWebhookVerifier(sandbox)!({ headers, event });

afterEach(() => { vi.unstubAllGlobals(); });

describe("PayPal webhook signature check", () => {
  it("stays off without a webhook id and never runs against live PayPal", () => {
    expect(paypalWebhookVerifier({ ...sandbox, PAYPAL_WEBHOOK_ID: undefined })).toBeNull();
    expect(paypalWebhookVerifier({ ...sandbox, PAYPAL_WEBHOOK_ID: "  " })).toBeNull();
    expect(() => paypalWebhookVerifier({ ...sandbox, PAYPAL_ENV: "live" })).toThrow(/sandbox/i);
  });

  it("accepts an event only when PayPal verifies its signature for this webhook", async () => {
    const fetch = paypalAnswers(async () => json({ access_token: "TOKEN" }), async () => json({ verification_status: "SUCCESS" }));
    expect(await verify()).toBe(true);
    const [url, init] = fetch.mock.calls[1];
    expect(String(url)).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer TOKEN");
    expect(JSON.parse(String(init?.body))).toEqual({
      auth_algo: "SHA256withRSA", cert_url: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      transmission_id: "T-1", transmission_sig: "SIG-1", transmission_time: "2026-11-07T20:00:00Z", webhook_id: "WH-ID-1", webhook_event: event,
    });
  });

  it("refuses an event PayPal does not verify", async () => {
    paypalAnswers(async () => json({ access_token: "TOKEN" }), async () => json({ verification_status: "FAILURE" }));
    expect(await verify()).toBe(false);
  });

  it("refuses when the token, the check or the network fails, instead of letting the event through", async () => {
    const refused = paypalAnswers(async () => json({ error: "invalid_client" }, 401), async () => json({ verification_status: "SUCCESS" }));
    expect(await verify()).toBe(false);
    expect(refused).toHaveBeenCalledTimes(1);

    paypalAnswers(async () => json({ access_token: "TOKEN" }), async () => json({ name: "INTERNAL_SERVICE_ERROR" }, 500));
    expect(await verify()).toBe(false);

    paypalAnswers(async () => json({ access_token: "TOKEN" }), async () => { throw new TypeError("fetch failed"); });
    expect(await verify()).toBe(false);

    paypalAnswers(async () => { throw new TypeError("fetch failed"); }, async () => json({ verification_status: "SUCCESS" }));
    expect(await verify()).toBe(false);
  });
});
