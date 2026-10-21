import type { NextRequest } from "next/server";
import { issuePricingResponse } from "@/pricing/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: Promise<{ caseKey: string }> }) {
  return issuePricingResponse(req, (await context.params).caseKey);
}
