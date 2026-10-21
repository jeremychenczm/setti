import type { NextRequest } from "next/server";
import { getPricingResponse, savePricingResponse } from "@/pricing/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ caseKey: string }> }) {
  return getPricingResponse(req, (await context.params).caseKey);
}

export async function PUT(req: NextRequest, context: { params: Promise<{ caseKey: string }> }) {
  return savePricingResponse(req, (await context.params).caseKey);
}
