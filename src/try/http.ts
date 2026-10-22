import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SandboxGuardError } from "@/config/paypalEnv";
import { createDb } from "@/db/client";
import { paypalLinks } from "@/payments/http";
import { sandboxPayPal, sandboxTestCard } from "@/payments/server";
import { readTrySeed, startTry } from "./service";

const uuid = z.uuid();
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const startSchema = z.strictObject({ restart: z.boolean().optional() });
/** Where a seeded visitor lands. */
const TRY_PROJECT_HREF = "/chats/maple";

const database = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };
function db() {
  database.settiChatDatabase ??= createDb();
  return database.settiChatDatabase.db;
}

function session(req: NextRequest): string | null {
  const parsed = uuid.safeParse(req.cookies.get("setti-demo-chat")?.value);
  return parsed.success ? parsed.data : null;
}

/** SETTI_TRY_PER_HOUR caps new seeds across all visitors; it defaults to 30. */
function perHour(): number {
  const raw = process.env.SETTI_TRY_PER_HOUR?.trim();
  const value = raw ? Number(raw) : 30;
  return Number.isInteger(value) && value >= 0 ? value : 30;
}

const failure = (code: string, error: string, status: number) => NextResponse.json({ code, error }, { status, headers });

export async function getTryResponse(req: NextRequest) {
  try {
    const seed = await readTrySeed(db(), session(req));
    return NextResponse.json({ seed: seed && { status: seed.status, changeOrderId: seed.changeOrderId }, href: TRY_PROJECT_HREF }, { headers });
  } catch {
    return failure("STORAGE_UNAVAILABLE", "Demo storage is unavailable. Make sure the database is running and migrated.", 503);
  }
}

export async function postTryResponse(req: NextRequest) {
  if (req.headers.get("origin") !== req.nextUrl.origin) return failure("FORBIDDEN", "Start the demo from this app's /try page.", 403);
  const text = await req.text();
  if (text.length > 1_024) return failure("INVALID_REQUEST", "The request is too large.", 413);
  let body: z.infer<typeof startSchema>;
  try { body = startSchema.parse(text ? JSON.parse(text) : {}); }
  catch { return failure("INVALID_REQUEST", "The request must be empty or JSON with an optional restart flag.", 400); }

  try {
    const result = await startTry({ db: db(), paypal: sandboxPayPal(), testCard: sandboxTestCard(), links: paypalLinks(req), perHour: perHour() }, session(req), body);
    if (result.kind === "busy") return failure("BUSY", "Your demo project is still being prepared. Wait a moment, then reload this page.", 409);
    if (result.kind === "limited") return failure("LIMITED", "The demo has prepared many projects in the last hour. Try again in a few minutes.", 429);
    if (result.kind === "failed") {
      console.error(`/try seed failed: ${result.message}`);
      return failure("SEED_FAILED", "Setti could not prepare the demo project on PayPal Sandbox. Try again in a minute.", 502);
    }
    const response = NextResponse.json({ href: TRY_PROJECT_HREF, changeOrderId: result.changeOrderId, reused: result.reused }, { headers });
    response.cookies.set("setti-demo-chat", result.session, {
      httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 30,
      secure: req.nextUrl.protocol === "https:",
    });
    return response;
  } catch (error) {
    if (error instanceof SandboxGuardError) return failure("PAYPAL_NOT_CONFIGURED", "PayPal Sandbox is not configured on this server.", 503);
    return failure("STORAGE_UNAVAILABLE", "Demo storage is unavailable. Make sure the database is running and migrated.", 503);
  }
}
