import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { CaseMessage } from "@/chat/types";
import { isAiInvocation } from "@/ai/intent";
import type { Db } from "@/db/client";
import type { StudioCase } from "@/demo/studio-types";
import { studioThreads } from "./schema";

export class StudioChatError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export function preparedMessages(project: StudioCase): CaseMessage[] {
  return project.messages.map((message, index) => ({ id: `prepared-${project.id}-${index}`, actor: message.actor, text: message.text, createdAt: message.at, replyToMessageId: null, aiState: "none", error: null, model: null }));
}

export function studioThreadStore(db: Db) {
  const where = (sessionId: string, projectId: string) => and(eq(studioThreads.sessionId, sessionId), eq(studioThreads.projectId, projectId));
  return {
    async read(sessionId: string, project: StudioCase) {
      const [row] = await db.select().from(studioThreads).where(where(sessionId, project.id));
      const messages = structuredClone(row?.messages ?? []);
      if (row?.activeSince && Date.now() - row.activeSince.getTime() >= 120_000) {
        for (const message of messages) if (message.aiState === "running") { message.aiState = "failed"; message.error = "The AI request was interrupted. Retry the saved message."; }
      }
      return [...preparedMessages(project), ...messages];
    },
    async append(sessionId: string, project: StudioCase, input: { id: string; text: string }) {
      if (project.stage === "settled") throw new StudioChatError("This completed project is read only.", 403);
      return db.transaction(async (tx) => {
        await tx.insert(studioThreads).values({ sessionId, projectId: project.id }).onConflictDoNothing();
        const [row] = await tx.select().from(studioThreads).where(where(sessionId, project.id)).for("update");
        const messages = structuredClone(row.messages);
        const existing = messages.find((message) => message.id === input.id);
        if (existing && (existing.actor !== "designer" || existing.text !== input.text)) throw new StudioChatError("This message ID has already been used. Refresh the conversation.");
        if (existing && (existing.aiState === "completed" || existing.aiState === "none")) return { messages: [...preparedMessages(project), ...messages], runId: null };
        if (existing && messages.slice(messages.indexOf(existing) + 1).some((message) => message.actor !== "assistant")) throw new StudioChatError("This project has newer discussion. Send a new @Coordinator message with your current request.");
        if (row.activeRunId && row.activeSince && Date.now() - row.activeSince.getTime() < 120_000) throw new StudioChatError("AI is working on this project. Wait a moment, then refresh or retry.");
        for (const message of messages) if (message.aiState === "running") { message.aiState = "failed"; message.error = "The previous AI request timed out. You can retry it."; }
        const ai = isAiInvocation(input.text);
        const message: CaseMessage = existing ?? { id: input.id, actor: "designer", text: input.text, createdAt: new Date().toISOString(), replyToMessageId: null, aiState: "none", error: null, model: null };
        if (!existing) messages.push(message);
        message.aiState = ai ? "running" : "none";
        message.error = null;
        const runId = ai ? randomUUID() : null;
        await tx.update(studioThreads).set({ messages, activeRunId: runId, activeSince: ai ? new Date() : null, updatedAt: new Date() }).where(where(sessionId, project.id));
        return { messages: [...preparedMessages(project), ...messages], runId };
      });
    },
    async finish(sessionId: string, project: StudioCase, messageId: string, runId: string, result: { text: string; model: string } | { error: string }) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(studioThreads).where(where(sessionId, project.id)).for("update");
        if (!row || row.activeRunId !== runId) throw new StudioChatError("A newer AI request has replaced this response. Refresh the conversation.");
        const messages = structuredClone(row.messages);
        const source = messages.find((message) => message.id === messageId)!;
        source.aiState = "error" in result ? "failed" : "completed";
        source.error = "error" in result ? result.error : null;
        if ("text" in result) messages.push({ id: randomUUID(), actor: "assistant", text: result.text, model: result.model, createdAt: new Date().toISOString(), replyToMessageId: messageId, aiState: "none", error: null });
        await tx.update(studioThreads).set({ messages, activeRunId: null, activeSince: null, updatedAt: new Date() }).where(where(sessionId, project.id));
        return [...preparedMessages(project), ...messages];
      });
    },
  };
}
