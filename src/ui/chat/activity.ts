import type { CaseMessage } from "@/chat/types";

/**
 * A saved record of what happened in the project (a signature, a PayPal result,
 * a supplier confirmation). It answers no one: the assistant's replies, even
 * fixed guidance, always reply to the message that asked.
 */
export function isActivityRecord(message: CaseMessage): boolean {
  return message.actor === "assistant" && message.model === "system" && !message.replyToMessageId;
}

export type TimelineEntry = { kind: "message"; message: CaseMessage } | { kind: "activity"; records: CaseMessage[] };

/** Records in a row become one entry, so a run of payment results reads as one update between the messages. */
export function chatTimeline(messages: readonly CaseMessage[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const message of messages) {
    const last = entries.at(-1);
    if (!isActivityRecord(message)) entries.push({ kind: "message", message });
    else if (last?.kind === "activity") last.records.push(message);
    else entries.push({ kind: "activity", records: [message] });
  }
  return entries;
}

/** The first sentence of a record, for the collapsed card. */
export function recordHeadline(text: string): string {
  return text.split(/(?<=[.!?])\s/u)[0];
}
