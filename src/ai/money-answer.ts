import type { MoneyAnswer, MoneyContext } from "./money-types";
import { aiTask, isExplicitDraftRequest } from "./intent";

/** A hint for deferring irrelevant product reads and protecting clearly read-only questions. */
export function isMoneyQuestion(text: string): boolean {
  if (isExplicitDraftRequest(text)) return false;
  const task = aiTask(text);
  const leadingExplanation = /^(?:(?:please|kindly)\s+)?(?:why|how|what|where|which|when|explain|show|tell|check|summari[sz]e|status)\b|^(?:(?:请|麻烦|帮我|帮忙|请帮我|请你)\s*)*(?:为什么|为何|怎么|怎样|解释|说明|核对|查询|查一下|查看|看看|看一下|总结)/iu;
  const englishChange = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)|(?:(?:i|we)\s+(?:want|would\s+like)\s+(?:you\s+)?to\s+)|(?:let['’]s\s+))?(?:(?:do\s+not|don't)\s+)?(?:replace|swap|change|increase|decrease|remove|return|cancel|add|keep|withdraw|revert)\b/iu;
  const chineseChange = /(?:改成|改为|换成|换为|替换成|替换为|退掉|取消|删掉|删除|移除|新增|增购|加上|撤回)(?!了)|先不退|先不换|不退了|不换了/u;
  // Asking for the price while requesting a change must still allow a review draft.
  // A leading explanation/status question about an earlier change stays read-only.
  if (!leadingExplanation.test(task) && (englishChange.test(task) || chineseChange.test(task))) return false;
  const subject = /budget|pay(?:ment|pal|ments)?|paid|charg|captur|refund|authoriz|hold|held|releas|balance|money|cost|资金|预算|付款|付了|付过|支付|收款|扣款|退款|退钱|退了|退回|授权|冻结|释放|余额|钱|费用|账|多少钱/iu;
  const question = /[?？]|\b(?:why|explain|status|how|what|where|which|show|tell|check|summari[sz]e)\b|为什么|为何|怎么|怎样|多少|哪里|哪笔|哪些|什么|有没有|是否|解释|说明|核对|看看|看一下|查一下|查询|进度|情况|账单|明细|总结/iu;
  return subject.test(text) && question.test(text);
}

/** Generic prose cannot bypass the grounded money response channel. */
export function hasUnsupportedMoneyClaim(text: string): boolean {
  return /[$€£¥￥]|\b(?:USD|dollars?|euros?)\b|\d[\d,.]*\s*(?:美元|元|美金)/iu.test(text)
    || /\b(?:unpaid|unrefunded|uncaptured|unsettled|paid|captured|charged|refunded|held|authorized|authorised|released|credited|collected|settled|debited|voided)\b/iu.test(text)
    || /\b(?:payment|refund|money|funds)\b.{0,35}\breceived\b|\breceived\b.{0,35}\b(?:payment|refund|money|funds)\b/iu.test(text)
    || /(?:already|not yet|no longer|fully|completed|succeeded|still|remaining|has been|have been).{0,35}(?:paid|captur|charg|refund|held|hold|authoriz|releas)|(?:paid|captur|charg|refund|authoriz|releas).{0,35}(?:completed|succeeded|pending|failed|unknown)|(?:已经|已|未|尚未|还没|没有|成功|完成|等待|仍待).{0,12}(?:付款|支付|扣款|退款|退钱|退还|退回|收款|收取|付清|授权|冻结|释放|到账|入账|结清)|(?:付款|支付|扣款|退款|退还|退回|收款|授权|冻结|释放).{0,10}(?:成功|完成|待处理|未知|失败|收到|到账|入账|还没|尚未)/iu.test(text);
}

/** The model selects relevance; it cannot supply amounts, statuses, sources or URLs. */
export function buildMoneyAnswer(context: MoneyContext, selected: readonly string[]): { text: string; moneyAnswer: MoneyAnswer } {
  if (!selected.length || selected.length > 16 || new Set(selected).size !== selected.length) throw new Error("Invalid money fact selection");
  const byId = new Map(context.facts.map((fact) => [fact.id, fact]));
  const bySource = new Map(context.sources.map((source) => [source.id, source]));
  const ids = [...new Set([...selected, ...(context.mandatoryFactIds ?? [])])];
  const facts = ids.map((id) => {
    const fact = byId.get(id);
    if (!fact || !fact.sourceIds.length || fact.sourceIds.some((source) => !bySource.has(source))) throw new Error("Unknown money evidence");
    return structuredClone(fact);
  });
  const sources = context.sources.filter((source) => facts.some((fact) => fact.sourceIds.includes(source.id)));
  if (sources.some((source) => !/^\/(?:quotes\/(?:maple|willow)|change-orders\/[0-9a-f-]{36})(?:#[a-zA-Z0-9_%.-]+)?$/.test(source.href))) throw new Error("Invalid money source");
  return {
    text: "Here is the evidence relevant to your question from this project's recorded approvals and payments.",
    moneyAnswer: {
      quoteId: context.quoteId, version: context.version, checkedAt: context.checkedAt,
      providerRecordedAt: context.providerRecordedAt, mode: context.mode, facts, sources: structuredClone(sources),
    },
  };
}
