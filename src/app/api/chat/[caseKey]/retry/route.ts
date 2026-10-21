import type { NextRequest } from "next/server";
import { postCaseResponse } from "@/chat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;

export async function POST(req: NextRequest, context: { params: Promise<{ caseKey: string }> }) {
  return postCaseResponse(req, (await context.params).caseKey, true);
}
