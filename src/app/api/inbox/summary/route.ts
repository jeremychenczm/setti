import type { NextRequest } from "next/server";
import { getInboxSummaryResponse } from "@/payments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return getInboxSummaryResponse(req);
}
