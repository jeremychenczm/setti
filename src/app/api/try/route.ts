import type { NextRequest } from "next/server";
import { getTryResponse, postTryResponse } from "@/try/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return getTryResponse(req);
}

export async function POST(req: NextRequest) {
  return postTryResponse(req);
}
