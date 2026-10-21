import { Client, Environment, OrdersController, PaymentsController } from "@paypal/paypal-server-sdk";
import { assertSandbox } from "@/config/paypalEnv";
import type { PayPalPayments } from "./paypal";
import { createSdkPayPal } from "./paypal-sdk";

const holder = globalThis as typeof globalThis & { settiPayPal?: PayPalPayments };

/** The one PayPal client the app uses. It refuses to exist unless the environment is the sandbox. */
export function sandboxPayPal(): PayPalPayments {
  if (!holder.settiPayPal) {
    const { clientId, clientSecret } = assertSandbox();
    const client = new Client({
      environment: Environment.Sandbox,
      timeout: 30_000,
      clientCredentialsAuthCredentials: { oAuthClientId: clientId, oAuthClientSecret: clientSecret },
    });
    holder.settiPayPal = createSdkPayPal({ orders: new OrdersController(client), payments: new PaymentsController(client) });
  }
  return holder.settiPayPal;
}
