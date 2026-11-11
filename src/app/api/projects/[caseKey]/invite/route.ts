import type { NextRequest } from "next/server";
import { postInviteResponse } from "@/projects/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ caseKey: string }> }) {
  return postInviteResponse(req, (await params).caseKey);
}
