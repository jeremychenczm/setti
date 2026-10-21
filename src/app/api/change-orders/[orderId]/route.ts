import type { NextRequest } from "next/server";
import { getChangeOrderResponse } from "@/pricing/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  return getChangeOrderResponse(req, (await context.params).orderId);
}
