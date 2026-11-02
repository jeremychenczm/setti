import type { NextRequest } from "next/server";
import { getDemoClockResponse, postDemoClockResponse } from "@/payments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return getDemoClockResponse(req);
}

export async function POST(req: NextRequest) {
  return postDemoClockResponse(req);
}
