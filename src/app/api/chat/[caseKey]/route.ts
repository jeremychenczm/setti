import type { NextRequest } from "next/server";
import { getCaseResponse, postCaseResponse } from "@/chat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;

type Context = { params: Promise<{ caseKey: string }> };

export async function GET(req: NextRequest, context: Context) {
  return getCaseResponse(req, (await context.params).caseKey);
}

export async function POST(req: NextRequest, context: Context) {
  return postCaseResponse(req, (await context.params).caseKey);
}
