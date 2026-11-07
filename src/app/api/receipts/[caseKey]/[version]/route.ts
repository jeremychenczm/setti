import type { NextRequest } from "next/server";
import { getReceiptResponse } from "@/receipts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ caseKey: string; version: string }> }) {
  const { caseKey, version } = await context.params;
  return getReceiptResponse(req, caseKey, version);
}
