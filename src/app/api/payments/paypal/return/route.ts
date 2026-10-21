import type { NextRequest } from "next/server";
import { paypalRedirectResponse } from "@/payments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return paypalRedirectResponse(req, "return");
}
