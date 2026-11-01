import type { NextRequest } from "next/server";
import { postDailyCheckResponse } from "@/payments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return postDailyCheckResponse(req);
}
