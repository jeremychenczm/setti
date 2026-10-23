/**
 * Test helpers. A test that needs an approved Willow baseline sends V1 and
 * signs it through the real stores, exactly as the designer and client do.
 */
import { randomUUID } from "node:crypto";
import { caseDocument } from "../chat/cases";
import { createChatStore } from "../chat/store";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import type { ApprovedQuoteReport } from "../quotes/types";
import { createOpeningStore } from "./store";
import { clientSignatureName, type QuoteView } from "./types";

/** A pure-test stand-in for a V1 whose client approved every line. */
export function approvedForTest(key: CaseKey, approvedAt = "2026-10-22T12:00:00.000Z"): ApprovedQuoteReport {
  const document = caseDocument(key);
  const name = clientSignatureName(document);
  const approval = { status: "approved" as const, approvedBy: name, approvedAt, signature: name, isDemo: true as const };
  return { ...document, status: "approved", approvedAt, approvedBy: name, signature: name, lines: document.lines.map((line) => ({ ...line, approval: { ...approval } })) };
}

/**
 * Sends V1 (once) and signs the given decisions as the client. Without
 * decisions, every undecided line is approved.
 */
export async function signOpeningForTest(db: Db, session: string, key: CaseKey, decisions?: { itemId: string; decision: "approved" | "declined"; note?: string }[]): Promise<QuoteView> {
  const chat = createChatStore(db);
  const state = await chat.getCase(session, key);
  if (state.opening?.status === "draft") await chat.sendQuote(session, key, { id: randomUUID(), text: "Here is quote V1.", sentBy: "Jordan Lee" });
  const view = await chat.getQuote(session, key);
  const pending = view.document.lines.filter((line) => view.lines[line.itemId].state === "pending");
  const chosen = decisions ?? pending.map((line) => ({ itemId: line.itemId, decision: "approved" as const }));
  if (!chosen.length) return view;
  return createOpeningStore(db).sign(session, key, {
    signingId: randomUUID(), contentHash: view.opening.contentHash!, signature: clientSignatureName(view.document), acknowledged: true, decisions: chosen,
  });
}
