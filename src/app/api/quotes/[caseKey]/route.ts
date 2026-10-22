import type { NextRequest } from "next/server";
import { getQuoteResponse } from "@/chat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ caseKey: string }> }) {
  return getQuoteResponse(req, (await context.params).caseKey);
}
