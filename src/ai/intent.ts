/** A message addressed to the project's agent starts with @Setti. */
const invocation = /^\s*@setti(?=$|[\s,:.!?])/iu;

export function isAiInvocation(text: string): boolean {
  return invocation.test(text);
}

export function aiTask(text: string): string {
  return text.replace(invocation, "").replace(/^[\s,:]+/u, "").trim();
}

/** Explicit preparation of a proposed quote is different from explaining recorded money. */
export function isExplicitDraftRequest(text: string): boolean {
  const task = aiTask(text);
  return /\b(?:prepare|draft(?:ing)?|create|assemble|produce|revise|update)\b.{0,100}\b(?:draft|propos(?:al|ed)|revised\s+quote|change\s+(?:set|order)|quote\s+(?:draft|revision))\b/iu.test(task)
    || /\b(?:summari[sz]e|consolidate)\b.{0,120}\binto\b.{0,30}\b(?:draft|propos(?:al|ed)|revised\s+quote|change\s+(?:set|order))\b/iu.test(task);
}
