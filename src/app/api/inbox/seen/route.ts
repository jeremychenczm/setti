import type { NextRequest } from "next/server";
import { postInboxSeenResponse } from "@/payments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return postInboxSeenResponse(req);
}
