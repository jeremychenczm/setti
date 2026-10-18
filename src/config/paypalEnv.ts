/**
 * Sandbox-only guard for every PayPal call this project makes.
 *
 * ROOM is a hackathon build: it must never touch a live PayPal account.
 * Anything that constructs a PayPal client goes through `assertSandbox()`
 * first, so a misconfigured environment fails loudly instead of moving
 * real money.
 */

export const PAYPAL_SANDBOX_HOST = "api-m.sandbox.paypal.com";

export interface SandboxCredentials {
  clientId: string;
  clientSecret: string;
}

export class SandboxGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxGuardError";
  }
}

type Env = Record<string, string | undefined>;

export function assertSandbox(env: Env = process.env): SandboxCredentials {
  const mode = env.PAYPAL_ENV?.trim().toLowerCase();
  if (mode !== "sandbox") {
    throw new SandboxGuardError(
      `PAYPAL_ENV must be "sandbox" (got ${JSON.stringify(env.PAYPAL_ENV ?? null)}). ` +
        "This project refuses to run against live PayPal.",
    );
  }

  // Optional override, used only to catch someone pointing the app at a
  // non-sandbox host by hand.
  const baseUrl = env.PAYPAL_BASE_URL?.trim();
  if (baseUrl) {
    let host: string;
    try {
      host = new URL(baseUrl).host;
    } catch {
      throw new SandboxGuardError(`PAYPAL_BASE_URL is not a valid URL: ${baseUrl}`);
    }
    if (host !== PAYPAL_SANDBOX_HOST) {
      throw new SandboxGuardError(
        `PAYPAL_BASE_URL must point at ${PAYPAL_SANDBOX_HOST} (got ${host}).`,
      );
    }
  }

  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new SandboxGuardError(
      "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required (sandbox app credentials).",
    );
  }

  return { clientId, clientSecret };
}
