import type { NextRequest } from "next/server";
import { postQuoteSignResponse } from "@/chat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: Promise<{ caseKey: string }> }) {
  return postQuoteSignResponse(req, (await context.params).caseKey);
}
