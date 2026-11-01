import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import type { Db } from "../db/client";
import { items, revisions } from "../db/schema";
import { chatCases, chatMessages } from "../chat/schema";
import { changeOrders, pricingCases } from "../pricing/schema";
import type { PaymentOperation } from "./operations";
import { activeSavedMethod } from "./saved-methods";

type Writer = Pick<Db, "select" | "insert">;
type Scope = { changeOrderId: string | null; revisionId?: string | null };

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** The conversation and version an operation belongs to; only a change order or a signed V1 has one. */
async function caseScope(tx: Writer, operation: Scope): Promise<{ caseId: string; version: number } | undefined> {
  const [scope] = operation.changeOrderId
    ? (await tx.select({ caseId: changeOrders.caseId, document: changeOrders.document }).from(changeOrders).where(eq(changeOrders.id, operation.changeOrderId)))
      .map((order) => ({ caseId: order.caseId, version: order.document.version }))
    : operation.revisionId
      ? await tx.select({ caseId: pricingCases.caseId, version: revisions.number }).from(pricingCases)
        .innerJoin(revisions, eq(revisions.id, pricingCases.baselineRevisionId)).where(eq(pricingCases.baselineRevisionId, operation.revisionId))
      : [];
  return scope;
}

/**
 * Adds a money event to the project conversation, so the case timeline shows
 * which version and item each PayPal result belongs to. Only operations bound to
 * a change order or to a signed V1 have a conversation.
 */
export async function noteInCase(tx: Writer, operation: Scope & { itemId: string | null; servicesHold?: boolean }, text: (context: { version: number; itemName: string }) => string): Promise<void> {
  if (!operation.itemId && !operation.servicesHold) return;
  const scope = await caseScope(tx, operation);
  const [item] = operation.itemId ? await tx.select({ name: items.name }).from(items).where(eq(items.id, operation.itemId)) : [{ name: "Design services" }];
  if (!scope || !item) return;
  await tx.insert(chatMessages).values({ caseId: scope.caseId, id: randomUUID(), actor: "assistant", model: "system", aiState: "completed", text: text({ version: scope.version, itemName: item.name }) });
}

type Hold = Pick<PaymentOperation, "status" | "amountCents">;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const furnitureItems = (count: number) => `${count} furniture ${count === 1 ? "item" : "items"}`;

/** What the client says about the furniture holds that followed their step. Only holds PayPal confirmed count as held. */
async function heldFurniture(tx: Tx, projectId: string, holds: Hold[]): Promise<string> {
  if (!holds.length) return "";
  const saved = await activeSavedMethod(tx, projectId);
  const on = saved?.kind === "card" ? `my card${saved.label ? ` ${saved.label}` : ""}` : "my PayPal";
  const held = holds.filter((hold) => hold.status === "succeeded");
  const heldCents = held.reduce((total, hold) => total + hold.amountCents, 0);
  return held.length === holds.length
    ? ` ${furnitureItems(held.length)} ${held.length === 1 ? "is" : "are"} held on ${on} (${usd(heldCents)}), to be charged as each supplier confirms.`
    : ` ${held.length} of ${furnitureItems(holds.length)} are held on ${on} (${usd(heldCents)}); the rest still need a hold.`;
}

/** The client's message that hands the next step to the designer; a fixed id writes it once however often the step is retried. */
async function handOff(tx: Tx, caseId: string, id: string, said: string): Promise<void> {
  const designer = DEMO_ACCOUNTS.find((account) => account.role === "designer")!.name.split(" ")[0];
  const inserted = await tx.insert(chatMessages).values({ caseId, id, actor: "client", text: `${said} Over to you, ${designer}.` })
    .onConflictDoNothing().returning({ id: chatMessages.id });
  if (inserted.length) await tx.update(chatCases).set({ updatedAt: new Date() }).where(eq(chatCases.id, caseId));
}

/**
 * Once the client has paid a version's design services in the app, the client's
 * own message tells the designer the next step is theirs, with the furniture
 * holds that followed the payment. The payment's id is the message id.
 */
export async function noteServicesPaid(db: Db, operation: Scope & { id: string; projectId: string; amountCents: number }, holds: Hold[]): Promise<void> {
  await db.transaction(async (tx) => {
    const scope = await caseScope(tx, operation);
    if (!scope) return;
    const paid = scope.version === 1 ? `I've signed quote V1 and paid the design services (${usd(operation.amountCents)}).` : `I've paid the design services for V${scope.version} (${usd(operation.amountCents)}).`;
    await handOff(tx, scope.caseId, operation.id, `${paid}${await heldFurniture(tx, operation.projectId, holds)}`);
  });
}

/** Once the client has confirmed a version, the same hand-off, with the new items held after it. The version's id is the message id. */
export async function noteVersionConfirmed(db: Db, orderId: string, holds: Hold[]): Promise<void> {
  await db.transaction(async (tx) => {
    const [order] = await tx.select({ caseId: changeOrders.caseId, document: changeOrders.document, projectId: pricingCases.projectId }).from(changeOrders)
      .innerJoin(pricingCases, eq(pricingCases.caseId, changeOrders.caseId)).where(eq(changeOrders.id, orderId));
    if (!order) return;
    await handOff(tx, order.caseId, orderId, `I've confirmed V${order.document.version}.${await heldFurniture(tx, order.projectId, holds)}`);
  });
}
