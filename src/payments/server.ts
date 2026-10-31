import { Client, Environment, OrdersController, PaymentsController, VaultController } from "@paypal/paypal-server-sdk";
import { assertSandbox } from "@/config/paypalEnv";
import type { PayPalPayments, TestCardApproval } from "./paypal";
import { createSdkPayPal, createSdkTestCardApproval } from "./paypal-sdk";

interface SandboxClients { payments: PayPalPayments; testCard: TestCardApproval }

const holder = globalThis as typeof globalThis & { settiSandbox?: SandboxClients };

/** Both clients share one SDK client, which refuses to exist unless the environment is the sandbox. */
function sandboxClients(): SandboxClients {
  if (!holder.settiSandbox) {
    const { clientId, clientSecret } = assertSandbox();
    const client = new Client({
      environment: Environment.Sandbox,
      timeout: 30_000,
      clientCredentialsAuthCredentials: { oAuthClientId: clientId, oAuthClientSecret: clientSecret },
    });
    const orders = new OrdersController(client);
    holder.settiSandbox = { payments: createSdkPayPal({ orders, payments: new PaymentsController(client), vault: new VaultController(client) }), testCard: createSdkTestCardApproval(orders) };
  }
  return holder.settiSandbox;
}

/** The one PayPal client the app's money steps use. */
export function sandboxPayPal(): PayPalPayments {
  return sandboxClients().payments;
}

/** Approves the orders /try seeds with the Sandbox test card. */
export function sandboxTestCard(): TestCardApproval {
  return sandboxClients().testCard;
}
