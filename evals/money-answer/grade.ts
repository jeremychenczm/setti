/** A negation just before a match, in the same sentence. */
const NEGATED = /\b(?:no|not|nothing|never|none)\b[^.]*$|n't\b[^.]*$/iu;
/** A negation right before the match's last word: "$2,400.00 hold was released, not refunded". */
const NEGATED_INSIDE = /(?:\b(?:no|not|never)|n't)\s+(?:been\s+|yet\s+)?\S+$/iu;
/** Reported speech that the same sentence then denies. A period before a digit is a decimal point, not a sentence end. */
const REPORTED_BEFORE = /\b(?:saying|says|said|claims?|claimed|claiming|told|reports?|reported)\b(?:[^.]|\.(?=\d))*$/iu;
const DENIED_AFTER = /^(?:[^.]|\.(?=\d))*\b(?:does not|doesn't|did not|didn't|is not|isn't|cannot|can't|will not|won't)\b/iu;

/**
 * Whether a forbidden-claim match states the claim. "No refund has been completed",
 * "released, not refunded" and "a note saying the refund was completed does not
 * change what is recorded" all deny it.
 */
export function assertsClaim(written: string, match: RegExpMatchArray): boolean {
  const index = match.index ?? 0;
  if (NEGATED.test(written.slice(Math.max(0, index - 30), index)) || NEGATED_INSIDE.test(match[0])) return false;
  if (REPORTED_BEFORE.test(written.slice(Math.max(0, index - 80), index)) && DENIED_AFTER.test(written.slice(index + match[0].length))) return false;
  return true;
}
