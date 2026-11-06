/**
 * Designer step: cancel an approved furniture item that nothing was charged
 * for, because the supplier cannot supply it, never answered, or the client
 * asked in the chat. Its open holds are voided (a release, not a refund) and no
 * version funds it again. Money only goes back to the client, so the designer
 * gives a reason instead of asking for a signature; a replacement is new money
 * and still goes through a version the client confirms.
 *
 * The cancellation, the designer's message to the client and the voids are written in one
 * transaction; PayPal is called after it. Repeating the step resumes the same
 * voids, and a void that failed is tried again under a new attempt.
 */
import { eq } from "drizzle-orm";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { itemCancellations, items } from "../db/schema";
import { attempt, openHolds, runEach } from "./actions";
import { PaymentActionError } from "./binding";
import { CANCELLATION_REASONS, cancellationMessage, type CancellationReason, type ItemCancellationReason } from "./cancellation";
import { noteFromDesigner } from "./notes";
import { insertOperation, type PaymentOperation } from "./operations";
import type { PayPalPayments } from "./paypal";
import { lockPaymentBasis } from "./services";
import { executeVoid } from "./void";

export type ItemCancellation = typeof itemCancellations.$inferSelect;

export interface CancelItemInput {
  /** The quote line of the current agreement. */
  itemId: string;
  /** Which side of a replacement the line is; V1 lines are always the baseline. */
  side?: "baseline" | "proposed";
  reason: ItemCancellationReason;
  note: string;
  /** The designer's name, as the chat shows it. */
  by: string;
}

/**
 * With `system`, Setti itself cancels the item when a demo ends: the reason is
 * demo_ended and the caller tells both people once, for the whole project,
 * instead of a message in the designer's name per item.
 */
export async function cancelApprovedItem(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, input: CancelItemInput, options: { system?: boolean } = {}): Promise<{ cancellation: ItemCancellation; operations: PaymentOperation[] }> {
  const note = input.note.trim(), by = input.by.trim();
  const allowed = options.system ? input.reason === "demo_ended" : (CANCELLATION_REASONS as readonly string[]).includes(input.reason);
  if (!allowed) throw new PaymentActionError("INVALID_INPUT", "Choose why the item is cancelled.");
  if (note.length > 1_000) throw new PaymentActionError("INVALID_INPUT", "Keep the note under 1,000 characters.");
  if (input.reason === "other" && !note) throw new PaymentActionError("INVALID_INPUT", "Say why the item is cancelled.");
  if (!by) throw new PaymentActionError("INVALID_INPUT", "The designer's name is missing.");

  const { cancellation, operations } = await db.transaction(async (tx) => {
    const basis = await lockPaymentBasis(tx, sessionId, key);
    const side = input.side ?? "baseline";
    const line = basis.plan.lines.find((entry) => entry.itemId === input.itemId && entry.side === side);
    const itemId = line && basis.businessItem(line);
    if (!line || !itemId) throw new PaymentActionError("NOT_FOUND", "This item is not part of the current agreement.");
    const [item] = await tx.select({ kind: items.kind, name: items.name }).from(items).where(eq(items.id, itemId));
    if (item?.kind !== "furniture") throw new PaymentActionError("NOT_AVAILABLE", "Only an approved product can be cancelled here.");
    const { ledger } = basis;

    let cancellation = ledger.cancellations.find((entry) => entry.itemId === itemId);
    if (!cancellation) {
      const charged = ledger.captures.some((capture) => capture.status !== "declined"
        && (capture.itemId === itemId || ledger.authorizations.some((hold) => hold.id === capture.authorizationId && hold.itemId === itemId)));
      if (charged) throw new PaymentActionError("NOT_AVAILABLE", `${item.name} was already charged, so it can no longer be cancelled. Returning that money is a refund.`);
      if (ledger.operations.some((operation) => operation.itemId === itemId && (operation.status === "pending" || operation.status === "unknown"))) {
        throw new PaymentActionError("PLAN_BLOCKED", `A PayPal step for ${item.name} is still open. Check its PayPal status before cancelling it.`);
      }
      if (line.targetCents === 0) throw new PaymentActionError("NOT_AVAILABLE", `The current agreement no longer funds ${item.name}.`);
      const binding = basis.bind(itemId);
      [cancellation] = await tx.insert(itemCancellations).values({
        projectId: basis.projectId, itemId, revisionId: binding.revisionId!, changeOrderId: binding.changeOrderId, reason: input.reason, note, cancelledBy: by,
      }).returning();
      const heldCents = openHolds(ledger, itemId).reduce((total, { heldCents: held }) => total + held, 0);
      // The client hears it from the designer, in the chat, once: the cancellation's id is the message id.
      if (!options.system) await noteFromDesigner(tx, binding, cancellation.id, cancellationMessage({ itemName: item.name, reason: input.reason as CancellationReason, note, heldCents }));
    }

    // One void per hold still open: an open void is resumed, a failed one is tried again.
    const created: PaymentOperation[] = [];
    for (const { hold, heldCents } of openHolds(ledger, itemId)) {
      const prefix = `cancel:${cancellation.id}:${hold.id}:`;
      const voids = ledger.operations.filter((operation) => operation.kind === "void" && operation.businessKey.startsWith(prefix));
      const open = voids.find((operation) => operation.status === "pending" || operation.status === "unknown");
      created.push(open ?? await insertOperation(tx, { businessKey: `${prefix}${attempt(ledger, "void", prefix)}`, projectId: basis.projectId, kind: "void", authorizationId: hold.id, amountCents: heldCents, binding: basis.bind(itemId) }));
    }
    return { cancellation, operations: created };
  });
  return { cancellation, operations: await runEach(operations, (id) => executeVoid(db, paypal, id)) };
}
