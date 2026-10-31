import { describe, expect, it } from "vitest";
import { PAYMENT_QUESTION, paymentQuestionHref, takePaymentQuestion } from "./payment-question";
import { isAiInvocation } from "@/ai/intent";

function store() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

describe("explicit payment question navigation", () => {
  it("carries the clicked request across navigation and consumes it once", () => {
    const storage = store();
    const url = new URL(paymentQuestionHref("maple", "click-id", storage), "http://localhost:3002");
    expect(url.pathname).toBe("/chats/maple");
    expect(takePaymentQuestion(url, "maple", storage)).toBe(true);
    expect(takePaymentQuestion(url, "maple", storage)).toBe(false);
    expect(isAiInvocation(PAYMENT_QUESTION)).toBe(true);
  });

  it("does not send automatically from a copied URL or a different project's chat", () => {
    const storage = store();
    const url = new URL(paymentQuestionHref("maple", "click-id", storage), "http://localhost:3002");
    expect(takePaymentQuestion(url, "maple", store())).toBe(false);
    expect(takePaymentQuestion(url, "willow", storage)).toBe(false);
    expect(takePaymentQuestion(new URL("/chats/maple", url), "maple", storage)).toBe(false);
    expect(takePaymentQuestion(url, "maple", storage)).toBe(true);
  });

  it("ignores an earlier click superseded by a new explicit click", () => {
    const storage = store();
    const first = new URL(paymentQuestionHref("maple", "first", storage), "http://localhost:3002");
    const second = new URL(paymentQuestionHref("maple", "second", storage), first);
    expect(takePaymentQuestion(first, "maple", storage)).toBe(false);
    expect(takePaymentQuestion(second, "maple", storage)).toBe(true);
  });
});
