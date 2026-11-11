import type { NextRequest } from "next/server";
import { postProjectResponse } from "@/projects/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return postProjectResponse(req);
}
