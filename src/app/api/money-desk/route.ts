import type { NextRequest } from "next/server";
import { getMoneyDeskResponse } from "@/money-desk/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return getMoneyDeskResponse(req);
}
