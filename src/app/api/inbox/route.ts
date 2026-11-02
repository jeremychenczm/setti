import type { NextRequest } from "next/server";
import { getInboxResponse } from "@/payments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return getInboxResponse(req);
}
