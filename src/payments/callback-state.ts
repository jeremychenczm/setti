import { createHmac, timingSafeEqual } from "node:crypto";
import { assertSandbox } from "../config/paypalEnv";

type Outcome = "return" | "cancel";

/** Private callback proof, scoped to one operation and one PayPal return route. */
export function callbackState(operationId: string, outcome: Outcome, secret = assertSandbox().clientSecret): string {
  return createHmac("sha256", secret).update(`setti:paypal-callback:v1:${outcome}:${operationId}`).digest("base64url");
}

export function validCallbackState(operationId: string, outcome: Outcome, state: string | null, secret?: string): boolean {
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return false;
  const expected = callbackState(operationId, outcome, secret);
  return timingSafeEqual(Buffer.from(state), Buffer.from(expected));
}
