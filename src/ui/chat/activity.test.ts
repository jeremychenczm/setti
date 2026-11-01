import { describe, expect, it } from "vitest";
import type { CaseMessage } from "@/chat/types";
import { chatTimeline, isActivityRecord, latestChatMessage, recordHeadline } from "./activity";

const message = (id: string, fields: Partial<CaseMessage> = {}): CaseMessage => ({
  id, actor: "client", text: id, createdAt: "2026-10-31T10:00:00.000Z", replyToMessageId: null, aiState: "none", error: null, model: null, ...fields,
});
const record = (id: string) => message(id, { actor: "assistant", model: "system", aiState: "completed" });

describe("chat activity records", () => {
  it("treats only unprompted system notes as records, never a reply to someone", () => {
    expect(isActivityRecord(record("signed"))).toBe(true);
    expect(isActivityRecord(message("guidance", { actor: "assistant", model: "system", replyToMessageId: "ask" }))).toBe(false);
    expect(isActivityRecord(message("answer", { actor: "assistant", model: "claude-opus-5-5", replyToMessageId: "ask" }))).toBe(false);
    expect(isActivityRecord(message("sofia"))).toBe(false);
    // An automatic notice both people must read stands on its own.
    expect(isActivityRecord(message("renewal", { actor: "assistant", model: "notice", aiState: "completed" }))).toBe(false);
  });

  it("groups records in a row and keeps every message in its place", () => {
    const entries = chatTimeline([message("v1", { actor: "designer" }), record("signed"), record("hold"), record("capture"), message("handoff"), record("supplier")]);
    expect(entries.map((entry) => entry.kind === "message" ? entry.message.id : entry.records.map((item) => item.id))).toEqual([
      "v1", ["signed", "hold", "capture"], "handoff", ["supplier"],
    ]);
  });

  it("previews the latest message someone wrote, not a record or an empty AI placeholder", () => {
    expect(latestChatMessage([message("handoff"), record("hold"), message("running", { actor: "assistant", text: " ", aiState: "running", replyToMessageId: "ask" })])?.id).toBe("handoff");
    expect(latestChatMessage([record("signed")])).toBeNull();
  });

  it("shows a record's first sentence without splitting amounts", () => {
    expect(recordHeadline("PayPal Sandbox capture completed for V1 · Design services: 1,250.00 USD taken. Capture ABC.")).toBe("PayPal Sandbox capture completed for V1 · Design services: 1,250.00 USD taken.");
  });
});
