import type { NextRequest } from "next/server";
import { postAcceptInviteResponse } from "@/projects/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return postAcceptInviteResponse(req);
}
