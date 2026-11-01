import type { NextRequest } from "next/server";
import { getAttentionResponse } from "@/payments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return getAttentionResponse(req);
}
