/** Grades a client inbox summary against where each item truly stands. */
import { amountsIn } from "@/ai/money-answer";
import type { SummarySentence } from "@/payments/schema";
import type { truthOf } from "./scenarios";

const PRESENT_HOLD = /\b(?:on hold|still held|held now|currently held|being held|(?:is|are|remains?)\s+(?:still\s+)?held|holds?\s+(?:include|includes|is|are|cover|covers|remain|remains)|largest hold|biggest hold)\b/iu;
const NOTHING_HELD = /\b(?:nothing|no money|no holds?)\b.{0,20}\b(?:on hold|held)\b/iu;

type ClauseState = "held-now" | "released" | "refunded" | "charged" | "hold-other";
function clauseState(clause: string): ClauseState | null {
  if (PRESENT_HOLD.test(clause)) return "held-now";
  if (/releas|void/iu.test(clause)) return "released";
  if (/refund/iu.test(clause)) return "refunded";
  if (/charg|captur|\bpaid\b|collect/iu.test(clause)) return "charged";
  if (/\bholds?\b|\bheld\b/iu.test(clause)) return "hold-other";
  return null;
}

/** A sentence's clauses with the money state each speaks of; a clause with no verb of its own continues the one before ("..., including ..."). */
export function clauses(text: string): { text: string; state: ClauseState | null }[] {
  let previous: ClauseState | null = null;
  // A comma inside $2,400.00 is not a clause break.
  return text.split(/,(?!\d{3})|[;:]|\band\b(?=\s+\$)|\bbut\b|\bwhile\b/iu).map((part) => {
    const state = clauseState(part) ?? previous;
    previous = state;
    return { text: part, state };
  });
}

/** Sentences that misstate what is on hold now, judged against the scenario's own truth. */
export function stateErrors(sentences: readonly SummarySentence[], truth: ReturnType<typeof truthOf>): string[] {
  const held = truth.items.filter((item) => item.heldCents > 0);
  const allowed = new Set([truth.heldCents, ...held.map((item) => item.heldCents)]);
  const lastWords = truth.items.map((item) => item.label.toLowerCase().split(" ").at(-1)!);
  const errors: string[] = [];
  sentences.forEach((sentence, index) => {
    if (NOTHING_HELD.test(sentence.text) && truth.heldCents > 0) errors.push(`Sentence ${index + 1} says nothing is on hold, but $${(truth.heldCents / 100).toFixed(2)} is.`);
    for (const clause of clauses(sentence.text).filter((entry) => entry.state === "held-now" && !NOTHING_HELD.test(entry.text))) {
      for (const amount of amountsIn(clause.text)) if (!allowed.has(amount)) errors.push(`Sentence ${index + 1} puts $${(amount / 100).toFixed(2)} on hold now ("${clause.text.trim()}"), which is not on hold.`);
      for (const item of truth.items.filter((entry) => entry.heldCents === 0)) {
        const word = item.label.toLowerCase().split(" ").at(-1)!;
        const unique = word.length >= 5 && lastWords.filter((other) => other === word).length === 1;
        if (clause.text.toLowerCase().includes(item.label.toLowerCase()) || (unique && new RegExp(`\b${word}\b`, "iu").test(clause.text))) errors.push(`Sentence ${index + 1} names ${item.label} as on hold now; it is not.`);
      }
    }
  });
  return errors;
}
