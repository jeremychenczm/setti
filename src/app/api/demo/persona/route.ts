import type { NextRequest } from "next/server";
import { postDemoPersonaResponse } from "@/try/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return postDemoPersonaResponse(req);
}
