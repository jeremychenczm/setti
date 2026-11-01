/** @AI or @Setti; @Change Agent is the assistant's earlier name and still works. */
const invocation = /^\s*@(?:ai|setti|change[\s-]?agent)(?=$|[\s,，:：.。!！?？])/iu;

export function isAiInvocation(text: string): boolean {
  return invocation.test(text);
}

export function aiTask(text: string): string {
  return text.replace(invocation, "").replace(/^[\s,，:：]+/u, "").trim();
}

/** Explicit preparation of a proposed quote is different from explaining recorded money. */
export function isExplicitDraftRequest(text: string): boolean {
  const task = aiTask(text);
  return /\b(?:prepare|draft(?:ing)?|create|assemble|produce|revise|update)\b.{0,100}\b(?:draft|propos(?:al|ed)|revised\s+quote|change\s+(?:set|order)|quote\s+(?:draft|revision))\b/iu.test(task)
    || /\b(?:summari[sz]e|consolidate)\b.{0,120}\binto\b.{0,30}\b(?:draft|propos(?:al|ed)|revised\s+quote|change\s+(?:set|order))\b/iu.test(task)
    || /(?:整理|汇总|生成|起草|准备|更新|修改).{0,50}(?:变更草稿|报价草稿|修订报价|变更报价|待核价|待审核报价|费用草稿)/u.test(task);
}
