/**
 * GET /api/receipts/{project}/{version}: the signed version receipt as JSON,
 * for the browser that owns the demo project. `?download=1` sends it as a file
 * named after the receipt number. The receipt carries PayPal ids, so unlike a
 * shared change-order link it is never served without the owning session.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ACCOUNT_COOKIE, canOpenProject, findAccount } from "@/accounts/demo";
import { isCaseKey } from "@/chat/cases";
import { createDb } from "@/db/client";
import { noteRequest } from "@/http/demo-activity";
import { readVersionReceipt, ReceiptError } from "./record";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const uuid = z.uuid();
const VERSION = /^[1-9]\d{0,2}$/;
const statuses = { NOT_FOUND: 404, NOT_SENT: 404, NOT_SIGNED: 409 } as const;

// The same pool the chat, approval and payment routes share.
const shared = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };
function database() {
  shared.settiChatDatabase ??= createDb();
  return shared.settiChatDatabase.db;
}

export async function getReceiptResponse(req: NextRequest, rawKey: string, rawVersion: string) {
  if (!isCaseKey(rawKey) || !VERSION.test(rawVersion)) return NextResponse.json({ code: "NOT_FOUND", error: "Receipt not found." }, { status: 404, headers });
  const session = uuid.safeParse(req.cookies.get("setti-demo-chat")?.value);
  if (!session.success) return NextResponse.json({ code: "FORBIDDEN", error: "Open this receipt from the browser that owns the demo project." }, { status: 403, headers });
  noteRequest(session.data);
  const account = findAccount(req.cookies.get(ACCOUNT_COOKIE)?.value);
  if (account && !canOpenProject(account, rawKey)) return NextResponse.json({ code: "FORBIDDEN", error: `${account.name} is not part of this project.` }, { status: 403, headers });
  try {
    const receipt = await readVersionReceipt(database(), session.data, rawKey, Number(rawVersion));
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
