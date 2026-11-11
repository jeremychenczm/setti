/**
 * GET /api/receipts/{project}/{version}: the signed version receipt as JSON,
 * for the project's studio and its client. `?download=1` sends it as a file
 * named after the receipt number. The receipt carries PayPal ids, so unlike a
 * shared change-order link it is never served to anyone outside the project.
 */
import { NextRequest, NextResponse } from "next/server";
import { isCaseKey } from "@/chat/cases";
import { appDb } from "@/db/shared";
import { isRefusal, projectScope } from "@/http/scope";
import { noteRequest } from "@/http/demo-activity";
import { readVersionReceipt, ReceiptError } from "./record";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const VERSION = /^[1-9]\d{0,2}$/;
const statuses = { NOT_FOUND: 404, NOT_SENT: 404, NOT_SIGNED: 409 } as const;

export async function getReceiptResponse(req: NextRequest, rawKey: string, rawVersion: string) {
  if (!isCaseKey(rawKey) || !VERSION.test(rawVersion)) return NextResponse.json({ code: "NOT_FOUND", error: "Receipt not found." }, { status: 404, headers });
  const scope = await projectScope(req, rawKey);
  if (isRefusal(scope)) return NextResponse.json({ code: scope.code, error: scope.error }, { status: scope.status, headers });
  noteRequest(scope.sessionId);
  try {
    const receipt = await readVersionReceipt(appDb(), scope.sessionId, rawKey, Number(rawVersion));
    const download = req.nextUrl.searchParams.get("download") === "1";
    return new NextResponse(JSON.stringify(receipt, null, 2), {
      headers: {
        ...headers, "Content-Type": "application/json; charset=utf-8",
        ...(download ? { "Content-Disposition": `attachment; filename="${receipt.receiptNo}.json"` } : {}),
      },
    });
  } catch (error) {
    if (error instanceof ReceiptError) return NextResponse.json({ code: error.code, error: error.message }, { status: statuses[error.code], headers });
    return NextResponse.json({ code: "STORAGE_UNAVAILABLE", error: "The receipt cannot be read right now. Make sure the database is running and migrated, then try again." }, { status: 503, headers });
  }
}
