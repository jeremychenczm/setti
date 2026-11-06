/**
 * The HTTP side of a demo's life: every request with a session cookie counts as
 * use, and once the demo has ended its project is a read-only record, so the
 * endpoints that change it refuse with 409.
 */
import { NextResponse } from "next/server";
import { createDb } from "@/db/client";
import { demoEnd, noteActivity, type DemoEnd } from "@/try/activity";

const database = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };
function db() {
  database.settiChatDatabase ??= createDb();
  return database.settiChatDatabase.db;
}

/** Notes that an existing session was used; never blocks or fails the request. */
export function noteRequest(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  try { void noteActivity(db(), sessionId).catch(() => undefined); } catch { /* no database configured: nothing to note */ }
}

/** How the app explains an ended demo. */
export function demoEndedText(end: DemoEnd): string {
  const day = new Date(end.at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const why = end.reason === "idle" ? `This demo ended on ${day} after a week without activity` : `This demo was ended on ${day}`;
  return `${why}, and its holds were released on PayPal. Its project stays here as a read-only record; start a new demo from /try.`;
}

/** A 409 for a write to an ended demo, or null while the demo is open. */
export async function refuseIfEnded(sessionId: string | null | undefined): Promise<NextResponse | null> {
  if (!sessionId) return null;
  let end: DemoEnd | null;
  try { end = await demoEnd(db(), sessionId); } catch { return null; }
  return end ? NextResponse.json({ code: "DEMO_ENDED", error: demoEndedText(end), demoEnded: end }, { status: 409, headers: { "Cache-Control": "no-store" } }) : null;
}
