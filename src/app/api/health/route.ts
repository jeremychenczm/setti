import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { createDb } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const database = globalThis as typeof globalThis & { settiHealthDatabase?: ReturnType<typeof createDb> };

/** For the host's health check: the database answers, and which commit is running. */
export async function GET() {
  database.settiHealthDatabase ??= createDb();
  try {
    await database.settiHealthDatabase.db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, commit: process.env.RENDER_GIT_COMMIT ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, commit: process.env.RENDER_GIT_COMMIT ?? null }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
