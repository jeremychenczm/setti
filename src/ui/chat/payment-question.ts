import type { CaseKey } from "@/chat/types";

export const PAYMENT_QUESTION = "@Coordinator Explain this project's recorded payments and anything still pending.";
const key = "setti:payment-question";
type RequestStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Only an explicit click in this tab authorizes the one-shot chat request. */
export function paymentQuestionHref(projectKey: CaseKey, token: string, storage: RequestStore): string {
  storage.setItem(key, JSON.stringify({ projectKey, token }));
  return `/chats/${projectKey}?ask=payments&request=${encodeURIComponent(token)}`;
}

/** Reloading or reopening the URL must not ask the model a second time. */
export function takePaymentQuestion(url: URL, projectKey: CaseKey, storage: RequestStore): boolean {
  if (url.pathname !== `/chats/${projectKey}` || url.searchParams.get("ask") !== "payments") return false;
  const token = url.searchParams.get("request");
  const saved = storage.getItem(key);
  if (!token || !saved) return false;
  const request = JSON.parse(saved) as { projectKey?: string; token?: string };
  if (request.projectKey !== projectKey || request.token !== token) return false;
  storage.removeItem(key);
  return true;
}
