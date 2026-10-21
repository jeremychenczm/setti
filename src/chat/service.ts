import { createHash } from "node:crypto";
import type { ChatStore, CaseKey, StoredCase, ProductPage } from "./types";
import { caseQuote } from "./cases";
import { aiTask, isAiInvocation } from "@/ai/intent";
import { aiConfigured, callChangeModel } from "@/ai/model";
import { buildDraft } from "@/ai/draft";
import { readProductPage } from "@/ai/product-page";

export function messageUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'，。！？；、）》）\u3000]+/gu) ?? [];
  return matches.map((value) => value.replace(/[，。！？；、）》）\]),;.!?]+$/gu, ""));
}

export function failedPage(url: string, error: string): ProductPage {
  return { id: `page-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`, url, fetchedAt: new Date().toISOString(), title: url, text: "", products: [], error };
}

export interface DraftDependencies {
  readPage: typeof readProductPage;
  callModel: typeof callChangeModel;
  configured: () => boolean;
}

export async function runCaseAi(store: ChatStore, sessionId: string, key: CaseKey, messageId: string, dependencies?: Partial<DraftDependencies>): Promise<StoredCase> {
  const deps: DraftDependencies = { readPage: readProductPage, callModel: callChangeModel, configured: aiConfigured, ...dependencies };
  const start = await store.beginAi(sessionId, key, messageId);
  if (start.status !== "started") {
    if (start.status === "completed") return start.state;
    throw new CaseAiError("AI 正在处理本项目的另一条消息，请稍后重试。");
  }
  const { runId, state } = start;
  try {
    const triggerIndex = state.messages.findIndex((message) => message.id === messageId);
    const trigger = state.messages[triggerIndex];
    if (!trigger || trigger.actor === "assistant" || !isAiInvocation(trigger.text)) throw new Error("只能重试主动 @AI 的本人消息。");
    if (!aiTask(trigger.text)) {
      return await store.completeAi(sessionId, key, messageId, runId, { text: "你希望我帮忙解释报价，还是整理哪项变更？可以直接说要调整什么，也可以附上商品链接。", model: "system" });
    }
    if (!deps.configured()) throw new Error("尚未配置模型 API。请配置服务端密钥并重启，随后可重试这条消息；当前没有生成 AI 草稿。");
    const messages = state.messages.slice(0, triggerIndex + 1);
    const urls = [...new Set(messages.filter((message) => message.actor !== "assistant").flatMap((message) => messageUrls(message.text)))];
    if (urls.length > 4) throw new Error("本轮测试每个项目最多读取 4 个不同商品链接。消息已保存；系统没有省略其他链接或聊天。");
    const pages = await Promise.all(urls.map(async (url) => {
      try { return await deps.readPage(url); }
      catch (error) { return failedPage(url, error instanceof Error ? error.message : "商品页面读取失败"); }
    }));
    const quote = state.quote ?? caseQuote(key);
    const result = await deps.callModel({ quote, messages, pages, current: state.draft, triggerId: messageId });
    const generated = buildDraft({ output: result.output, quote, messages, pages, current: state.draft, triggerId: messageId, model: result.model });
    return await store.completeAi(sessionId, key, messageId, runId, { ...generated, model: result.model });
  } catch (error) {
    // Never persist API error bodies, secrets, SQL, or upstream request headers.
    let userError = "AI 调用或结果校验失败，本次未更新草稿。请检查模型配置和网络后重试。";
    if (error instanceof Error && !error.message.match(/(?:api[_ -]?key|bearer|sk-ant-|select |insert |postgres|password)/iu)) {
      if (/^(当前项目|本轮测试|尚未配置|模型未返回|只能重试)/u.test(error.message)) userError = error.message;
    }
    await store.failAi(sessionId, key, messageId, runId, userError);
    throw new CaseAiError(userError);
  }
}

export class CaseAiError extends Error {}
