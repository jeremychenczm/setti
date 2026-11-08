import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ACCOUNT_COOKIE, findAccount } from "@/accounts/demo";
import { createDb } from "@/db/client";
import { noteRequest } from "@/http/demo-activity";
import { refreshDemoCookies } from "@/http/demo-cookies";
import { moneyDesk } from "./desk";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const database = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };
function db() {
  database.settiChatDatabase ??= createDb();
  return database.settiChatDatabase.db;
}

function session(req: NextRequest): string | null {
  const parsed = z.uuid().safeParse(req.cookies.get("setti-demo-chat")?.value);
  if (!parsed.success) return null;
  noteRequest(parsed.data);
  return parsed.data;
}

/** The designer's money desk across the projects this browser session owns, plus the prepared examples. */
export async function getMoneyDeskResponse(req: NextRequest) {
  const account = findAccount(req.cookies.get(ACCOUNT_COOKIE)?.value);
  if (account?.role !== "designer") return NextResponse.json({ code: "FORBIDDEN", error: "Only the designer sees the money desk." }, { status: 403, headers });
  try { return refreshDemoCookies(NextResponse.json(await moneyDesk(db(), session(req), account), { headers }), req); }
  catch { return NextResponse.json({ code: "STORAGE_UNAVAILABLE", error: "The payment records could not be read. Try again shortly." }, { status: 503, headers }); }
}
