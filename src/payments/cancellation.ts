/** Why the studio cancelled an approved item before it was charged, and how each reason reads. Shared by the server and the page. */
export const CANCELLATION_REASONS = ["unavailable", "no_response", "client_asked", "other"] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export const CANCELLATION_REASON_TEXT: Record<CancellationReason, string> = {
  unavailable: "Out of stock or discontinued",
  no_response: "Supplier didn't respond",
  client_asked: "Client asked to cancel",
  other: "Other",
};

/** Why, in the designer's own voice to the client. */
const BECAUSE: Record<Exclude<CancellationReason, "other">, string> = {
  unavailable: "the supplier can't supply it",
  no_response: "the supplier never confirmed the order",
  client_asked: "you asked me to",
};

const sentence = (text: string) => { const trimmed = text.trim(); return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`; };
const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/**
 * The message the client reads in the project chat, in the designer's name.
 * The cancel form shows this same text before the designer confirms it.
 */
export function cancellationMessage(input: { itemName: string; reason: CancellationReason; note: string; heldCents: number }): string {
  const note = input.note.trim();
  const why = input.reason === "other" ? `Update on ${input.itemName}: I've cancelled it. ${sentence(note)}`
    : `Update on ${input.itemName}: I've cancelled it because ${BECAUSE[input.reason]}.${note ? ` ${sentence(note)}` : ""}`;
  const money = input.heldCents > 0 ? `Nothing was charged for it, and its ${usd(input.heldCents)} hold is being released on PayPal.` : "Nothing was charged or held for it.";
  return `${why} ${money} If you'd like a replacement, I'll send it to you as a new version to confirm.`;
}
