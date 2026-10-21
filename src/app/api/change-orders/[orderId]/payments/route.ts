import type { NextRequest } from "next/server";
import { getPaymentsResponse, postPaymentsResponse } from "@/payments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  return getPaymentsResponse(req, (await context.params).orderId);
}

export async function POST(req: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  return postPaymentsResponse(req, (await context.params).orderId);
}
