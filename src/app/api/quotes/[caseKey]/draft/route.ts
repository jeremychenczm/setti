import type { NextRequest } from "next/server";
import { putQuoteDraftResponse } from "@/projects/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ caseKey: string }> }) {
  return putQuoteDraftResponse(req, (await params).caseKey);
}
