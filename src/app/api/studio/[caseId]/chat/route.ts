import type { NextRequest } from "next/server";
import { studioChatResponse } from "@/studio/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{ caseId: string }> };
export async function GET(req: NextRequest, context: Context) { return studioChatResponse(req, (await context.params).caseId); }
export async function POST(req: NextRequest, context: Context) { return studioChatResponse(req, (await context.params).caseId); }
