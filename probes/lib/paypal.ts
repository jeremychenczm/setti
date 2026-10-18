/**
 * Shared PayPal client for probes. Loads .env.local, refuses to run unless the
 * environment is sandbox, and exposes the controllers the probes need.
 */
import { existsSync } from "node:fs";
import {
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  VaultController,
  type OrderAuthorizeResponse,
  type Order,
} from "@paypal/paypal-server-sdk";
import { assertSandbox } from "../../src/config/paypalEnv";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const { clientId, clientSecret } = assertSandbox();

export const client = new Client({
  environment: Environment.Sandbox,
  timeout: 30_000,
  clientCredentialsAuthCredentials: { oAuthClientId: clientId, oAuthClientSecret: clientSecret },
});

export const orders = new OrdersController(client);
export const payments = new PaymentsController(client);
export const vault = new VaultController(client);

/** Ask PayPal for the full resource, not the minimal id/status/links body. */
export const FULL = "return=representation";

/** Placeholder redirect targets for buyer approval in the sandbox. */
export const RETURN_URL = "https://example.com/room-probe/return";
export const CANCEL_URL = "https://example.com/room-probe/cancel";

export function usd(cents: number) {
  return { currencyCode: "USD", value: (cents / 100).toFixed(2) };
}

/** Deterministic request id so a re-run of the same step is idempotent on PayPal's side. */
export function requestId(probe: string, step: string, key: string): string {
  return `room-${probe}-${step}-${key}`.slice(0, 108);
}

export function linkHref(links: { rel: string; href: string }[] | undefined, ...rels: string[]): string | undefined {
  return links?.find((l) => rels.includes(l.rel))?.href;
}

/** The first authorization on the first purchase unit, if the order has one. */
export function firstAuthorization(order: Order | OrderAuthorizeResponse | undefined) {
  return order?.purchaseUnits?.[0]?.payments?.authorizations?.[0];
}

export function dollarsToCents(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(Number(value) * 100);
}
