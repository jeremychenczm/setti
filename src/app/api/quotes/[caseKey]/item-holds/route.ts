import type { NextRequest } from "next/server";
import { getItemHoldsResponse, postItemHoldsResponse } from "@/payments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ caseKey: string }> }) {
  return getItemHoldsResponse(req, (await context.params).caseKey);
}

export async function POST(req: NextRequest, context: { params: Promise<{ caseKey: string }> }) {
  return postItemHoldsResponse(req, (await context.params).caseKey);
}
