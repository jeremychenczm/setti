/**
 * PayPal webhooks: PayPal tells Setti when a hold, charge or refund it made
 * changes. An event counts only after PayPal's verify-webhook-signature API says
 * PayPal sent it; it is kept once by its event id and matched to the Setti
 * operation it is about. Events confirm what Setti recorded ("Confirmed by
 * PayPal" in the client's inbox); they never change money records by themselves.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalAuthorizations, paypalWebhookEvents } from "../db/schema";
import { assertSandbox, PAYPAL_SANDBOX_HOST } from "../config/paypalEnv";

export type WebhookVerifier = (input: { headers: Headers; event: unknown }) => Promise<boolean>;

/** PayPal's own check of an event's signature, or null when the server has no webhook id. */
export function paypalWebhookVerifier(env: NodeJS.ProcessEnv = process.env): WebhookVerifier | null {
  const webhookId = env.PAYPAL_WEBHOOK_ID?.trim();
  if (!webhookId) return null;
  const { clientId, clientSecret } = assertSandbox(env);
  const base = env.PAYPAL_BASE_URL?.trim() || `https://${PAYPAL_SANDBOX_HOST}`;
  return async ({ headers, event }) => {
    const token = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST", body: "grant_type=client_credentials",
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    }).then((response) => response.ok ? response.json() as Promise<{ access_token?: string }> : null).catch(() => null);
    if (!token?.access_token) return false;
    const verdict = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
      method: "POST", headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: headers.get("paypal-auth-algo"), cert_url: headers.get("paypal-cert-url"), transmission_id: headers.get("paypal-transmission-id"),
        transmission_sig: headers.get("paypal-transmission-sig"), transmission_time: headers.get("paypal-transmission-time"), webhook_id: webhookId, webhook_event: event,
      }),
    }).then((response) => response.ok ? response.json() as Promise<{ verification_status?: string }> : null).catch(() => null);
    return verdict?.verification_status === "SUCCESS";
  };
}

interface PayPalEvent {
  id?: string;
  event_type?: string;
  create_time?: string;
  resource?: { id?: string; status?: string; amount?: { value?: string } };
}

/** The operation an event's resource belongs to: the step that produced it, or for a voided hold, the release. */
async function matchOperation(db: Pick<Db, "select">, eventType: string, resourceId: string): Promise<string | null> {
  if (eventType === "PAYMENT.AUTHORIZATION.VOIDED") {
    const [release] = await db.select({ id: paymentOperations.id }).from(paymentOperations)
      .innerJoin(paypalAuthorizations, eq(paypalAuthorizations.id, paymentOperations.authorizationId))
      .where(and(eq(paymentOperations.kind, "void"), eq(paypalAuthorizations.paypalAuthorizationId, resourceId)));
    if (release) return release.id;
  }
  const [produced] = await db.select({ id: paymentOperations.id }).from(paymentOperations)
    .where(and(eq(paymentOperations.paypalResourceId, resourceId), inArray(paymentOperations.kind, ["authorize", "capture", "refund"])));
  return produced?.id ?? null;
}

/** Keeps a verified event once. Returns whether it was new and which operation it matched. */
export async function recordWebhookEvent(db: Db, event: unknown): Promise<{ stored: boolean; operationId: string | null }> {
  const parsed = event as PayPalEvent;
  if (!parsed?.id || !parsed.event_type) throw new Error("A PayPal webhook event needs an id and a type.");
  const resourceId = parsed.resource?.id ?? null;
  const operationId = resourceId ? await matchOperation(db, parsed.event_type, resourceId) : null;
  const value = parsed.resource?.amount?.value;
  const amountCents = value && /^\d+(\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : null;
  const created = parsed.create_time ? new Date(parsed.create_time) : null;
  const inserted = await db.insert(paypalWebhookEvents).values({
    eventId: parsed.id, eventType: parsed.event_type, resourceId, resourceStatus: parsed.resource?.status ?? null, amountCents, operationId,
    paypalCreatedAt: created && !Number.isNaN(created.getTime()) ? created : null,
  }).onConflictDoNothing().returning({ eventId: paypalWebhookEvents.eventId });
  return { stored: inserted.length > 0, operationId };
}
