import type { NextRequest } from "next/server";
import { getApprovalResponse, postApprovalResponse } from "@/approval/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  return getApprovalResponse(req, (await context.params).orderId);
}

export async function POST(req: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  return postApprovalResponse(req, (await context.params).orderId);
}
