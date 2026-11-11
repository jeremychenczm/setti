import { NextRequest, NextResponse } from "next/server";
import { appDb } from "@/db/shared";
import { noteRequest } from "@/http/demo-activity";
import { isRefusal, studioScope } from "@/http/scope";
import { moneyDesk } from "./desk";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

/** The designer's money desk across their studio's projects, plus the prepared examples. */
export async function getMoneyDeskResponse(req: NextRequest) {
  const scope = await studioScope(req);
  if (isRefusal(scope)) return NextResponse.json({ code: scope.code, error: scope.error }, { status: scope.status, headers });
  noteRequest(scope.sessionId);
  try { return NextResponse.json(await moneyDesk(appDb(), scope.sessionId, scope.account), { headers }); }
  catch { return NextResponse.json({ code: "STORAGE_UNAVAILABLE", error: "The payment records could not be read. Try again shortly." }, { status: 503, headers }); }
}
