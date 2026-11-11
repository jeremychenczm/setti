/**
 * Grades a client inbox summary against the scenario's own records: every amount
 * it writes must be one those records hold. It does not read the wording for what
 * is on hold: that rule misread item-by-item sentences such as "two items are
 * charged, with nothing on hold", and the server's own check already ties each
 * sentence to the facts it cites.
 */
import { amountsIn } from "@/ai/money-answer";
import type { SummarySentence } from "@/payments/schema";
import type { truthOf } from "./scenarios";

/** Amounts a summary writes that the scenario never records. */
export function amountErrors(sentences: readonly SummarySentence[], truth: ReturnType<typeof truthOf>): string[] {
  return sentences.flatMap((sentence, index) => amountsIn(sentence.text)
    .filter((amount) => !truth.recordedCents.has(amount))
    .map((amount) => `Sentence ${index + 1} writes $${(amount / 100).toFixed(2)}, which no record or total holds.`));
}
