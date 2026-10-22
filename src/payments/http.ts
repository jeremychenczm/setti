import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SandboxGuardError } from "@/config/paypalEnv";
import { createDb } from "@/db/client";
import { cancelPayment, checkPayment, operationChangeOrder, returnFromPayPal, startAuthorization, startCapture, startRefund, startRelease, type LinkBuilder } from "./actions";
import { PaymentActionError } from "./binding";
import { PaymentOperationError } from "./operations";
import { sandboxPayPal } from "./server";
import { callbackState, validCallbackState } from "./callback-state";
import { recordSupplierCredit, recordSupplierOrder } from "./supplier";
import { paymentsWorkspace } from "./workspace";

const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const line = { itemId: z.string().min(1).max(300), side: z.enum(["baseline", "proposed"]), contentHash: hash, revisionContentHash: hash };
const cents = z.number().int().min(0).max(2_000_000_000);
const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("authorize"), ...line }),
  z.strictObject({ action: z.literal("capture"), ...line }),
  z.strictObject({ action: z.literal("release"), ...line }),
  z.strictObject({ action: z.literal("refund"), ...line }),
  z.strictObject({
    action: z.literal("supplier_order"), ...line, quantity: z.number().int().min(1).max(10_000), unitPriceCents: cents, taxCents: cents, freightCents: cents,
    inStock: z.boolean(), leadTimeDays: z.number().int().min(0).max(3_650).nullable(), reference: z.string().trim().min(1).max(200), note: z.string().trim().max(1_000),
  }),
  z.strictObject({ action: z.literal("supplier_credit"), ...line, creditCents: cents, reference: z.string().trim().min(1).max(200), note: z.string().trim().max(1_000) }),
  z.strictObject({ action: z.literal("check"), operationId: uuid }),
  z.strictObject({ action: z.literal("cancel"), operationId: uuid }),
]);
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }

const database = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };
function db() {
  database.settiChatDatabase ??= createDb();
  return database.settiChatDatabase.db;
}

function session(req: NextRequest): string | null {
  const parsed = uuid.safeParse(req.cookies.get("setti-demo-chat")?.value);
  return parsed.success ? parsed.data : null;
}

/** PayPal sends the buyer back here; SETTI_PUBLIC_URL overrides the request origin when the app runs behind a proxy. */
function links(req: NextRequest): LinkBuilder {
  const base = (process.env.SETTI_PUBLIC_URL?.trim() || req.nextUrl.origin).replace(/\/$/, "");
  return (operationId) => ({
    returnUrl: `${base}/api/payments/paypal/return?op=${operationId}&state=${callbackState(operationId, "return")}`,
    cancelUrl: `${base}/api/payments/paypal/cancel?op=${operationId}&state=${callbackState(operationId, "cancel")}`,
  });
}

async function boundedJson(req: NextRequest): Promise<unknown> {
  if (req.headers.get("origin") !== req.nextUrl.origin) throw new HttpError("Payment steps must be started from this app's pages.", 403);
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new HttpError("The request must be JSON.", 415);
  if (!req.body) throw new HttpError("The payment request is empty.", 400);
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8_192) { await reader.cancel(); throw new HttpError("The payment request is too large.", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError("The payment request is not valid JSON.", 400); }
}

const statuses: Record<string, number> = {
  FORBIDDEN: 403, NOT_FOUND: 404, INVALID_INPUT: 400, CONTENT_CHANGED: 409, NOT_CONFIRMED: 409, STALE_VERSION: 409,
  PLAN_BLOCKED: 409, NOT_AVAILABLE: 409, OPERATION_REFUSED: 409, IDEMPOTENCY_CONFLICT: 409, SUPPLIER_TERMS_CHANGED: 409,
};

function fail(error: unknown) {
  if (error instanceof HttpError) return NextResponse.json({ code: "INVALID_REQUEST", error: error.message }, { status: error.status, headers });
  if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", error: "Check the payment step, line and version." }, { status: 400, headers });
  if (error instanceof PaymentActionError || error instanceof PaymentOperationError) {
    return NextResponse.json({ code: error.code, error: error.message, details: error instanceof PaymentActionError ? error.details : [] }, { status: statuses[error.code] ?? 409, headers });
  }
  if (error instanceof SandboxGuardError) return NextResponse.json({ code: "PAYPAL_NOT_CONFIGURED", error: "PayPal Sandbox is not configured on this server." }, { status: 503, headers });
  return NextResponse.json({ code: "STORAGE_UNAVAILABLE", error: "The payment records could not be read or saved. Check the saved status before retrying." }, { status: 503, headers });
}

export async function getPaymentsResponse(req: NextRequest, id: string) {
  if (!uuid.safeParse(id).success) return NextResponse.json({ code: "NOT_FOUND", error: "This change order could not be found." }, { status: 404, headers });
  try {
    const workspace = await paymentsWorkspace(db(), session(req), id);
    return workspace ? NextResponse.json(workspace, { headers }) : NextResponse.json({ code: "NOT_FOUND", error: "This change order could not be found." }, { status: 404, headers });
  } catch (error) { return fail(error); }
}

export async function postPaymentsResponse(req: NextRequest, id: string) {
  if (!uuid.safeParse(id).success) return NextResponse.json({ code: "NOT_FOUND", error: "This change order could not be found." }, { status: 404, headers });
  const sessionId = session(req);
  if (!sessionId) return NextResponse.json({ code: "FORBIDDEN", error: "This share link is read-only. Payment steps run only from the browser that owns the demo case." }, { status: 403, headers });
  try {
    const input = actionSchema.parse(await boundedJson(req));
    let operationId: string | null = null, redirectUrl: string | null = null;
    switch (input.action) {
      case "authorize": {
        const operation = await startAuthorization(db(), sandboxPayPal(), sessionId, id, input, links(req));
        operationId = operation.id;
        redirectUrl = operation.status === "pending" && !operation.paypalResourceId ? operation.approvalUrl : null;
        break;
      }
      case "capture":
        operationId = (await startCapture(db(), sandboxPayPal(), sessionId, id, input))[0]?.id ?? null;
        break;
      case "release":
        operationId = (await startRelease(db(), sandboxPayPal(), sessionId, id, input))[0]?.id ?? null;
        break;
      case "refund":
        operationId = (await startRefund(db(), sandboxPayPal(), sessionId, id, input))[0]?.id ?? null;
        break;
      case "supplier_order":
        await recordSupplierOrder(db(), sessionId, id, input);
        break;
      case "supplier_credit":
        await recordSupplierCredit(db(), sessionId, id, input);
        break;
      case "check":
        operationId = (await checkPayment(db(), sandboxPayPal(), sessionId, id, input.operationId, links(req))).id;
        break;
      case "cancel":
        operationId = (await cancelPayment(db(), sandboxPayPal(), sessionId, id, input.operationId)).id;
        break;
    }
    return NextResponse.json({ workspace: await paymentsWorkspace(db(), sessionId, id), operationId, redirectUrl }, { headers });
  } catch (error) { return fail(error); }
}

/** PayPal redirects the buyer here after approving (`return`) or leaving (`cancel`). */
export async function paypalRedirectResponse(req: NextRequest, outcome: "return" | "cancel") {
  const operationId = uuid.safeParse(req.nextUrl.searchParams.get("op"));
  const home = new URL("/", req.nextUrl.origin);
  if (!operationId.success) return NextResponse.redirect(home, 303);
  const page = (orderId: string, state: string) => {
    const target = new URL(`/change-orders/${orderId}`, req.nextUrl.origin);
    target.searchParams.set("paypal", state);
    target.hash = "payments";
    return NextResponse.redirect(target, 303);
  };
  let orderId: string | null = null;
  try {
    if (!validCallbackState(operationId.data, outcome, req.nextUrl.searchParams.get("state"))) return NextResponse.redirect(home, 303);
    orderId = await operationChangeOrder(db(), operationId.data);
    const result = await returnFromPayPal(db(), sandboxPayPal(), operationId.data, req.nextUrl.searchParams.get("token"), outcome);
    if (!result) return orderId ? page(orderId, "unmatched") : NextResponse.redirect(home, 303);
    return page(result.orderId, outcome === "cancel" && result.state === "failed" ? "cancelled" : result.state);
  } catch {
    // The page offers "Check PayPal status", which reads the real outcome again.
    return orderId ? page(orderId, "unknown") : NextResponse.redirect(home, 303);
  }
}
