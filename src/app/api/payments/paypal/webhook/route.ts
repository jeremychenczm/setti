import type { NextRequest } from "next/server";
import { postPayPalWebhookResponse } from "@/payments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return postPayPalWebhookResponse(req);
}
