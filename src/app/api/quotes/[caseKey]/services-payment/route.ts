import type { NextRequest } from "next/server";
import { getServicesPaymentResponse, postServicesPaymentResponse } from "@/payments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ caseKey: string }> }) {
  return getServicesPaymentResponse(req, (await context.params).caseKey);
}

export async function POST(req: NextRequest, context: { params: Promise<{ caseKey: string }> }) {
  return postServicesPaymentResponse(req, (await context.params).caseKey);
}
