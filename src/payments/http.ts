import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isCaseKey } from "@/chat/cases";
import type { CaseKey } from "@/chat/types";
import { assertSandbox, SandboxGuardError } from "@/config/paypalEnv";
import { appDb } from "@/db/shared";
import { requestActor } from "@/http/actor";
import { noteRequest, refuseIfEnded } from "@/http/demo-activity";
import { homeOf, type Actor } from "@/http/identity";
import { orderScope } from "@/http/order-scope";
import { isSameOriginRequest, requestOrigin } from "@/http/origin";
import { isRefusal, NOT_YOUR_PROJECT, projectScope, refusalResponse, SIGN_IN_REQUIRED, studioScope, type ProjectScope } from "@/http/scope";
import { paymentPreparationPending, PREPARATION_MESSAGE } from "../try/preparation";
import { cancelPayment, checkPayment, operationPage, returnFromPayPal, startAuthorization, startCapture, startOpeningCapture, startRefund, startRelease, type LinkBuilder } from "./actions";
import { cancelCheckout, completeAuthorization } from "./authorize";
import { PaymentActionError } from "./binding";
import { attentionView } from "./attention-view";
import { cancelApprovedItem } from "./cancel-item";
import { runDailyCheck } from "./daily-check";
import { inboxBadge, inboxFacts, inboxView, markInboxOpened } from "./inbox-view";
import { paypalWebhookVerifier, recordWebhookEvent, type WebhookVerifier } from "./webhook";
import { takeAiAllowance } from "../ai/allowance";
import { summarizeInbox } from "../ai/inbox-summary";
import { DemoClockError, demoDays, MAX_SKIP_DAYS, skipAhead } from "../try/clock";
import { CANCELLATION_REASONS } from "./cancellation";
import { PaymentOperationError } from "./operations";
import { sandboxPayPal, sandboxTestCard } from "./server";
import { removeCaseSavedMethod } from "./saved-methods";
import { approveCheckoutWithTestCard } from "./test-card";
import type { DemoCheckout } from "./types";
import { callbackState, validCallbackState } from "./callback-state";
import { recordOpeningSupplierOrder, recordSupplierCredit, recordSupplierOrder } from "./supplier";
import { paymentsWorkspace } from "./workspace";
import { refreshRecordedFees } from "./fee-refresh";
import { cancelItemHold, checkItemHold, holdApprovedItems, startItemCheckout } from "./item-holds";
import { itemHoldsView } from "./item-holds-view";
import { checkServicesCheckout, lockPaymentBasis, startServicesCheckout } from "./services";
import { afterServicesPaid } from "./services-paid";
import { afterVersionConfirmed } from "./version-confirmed";
import { servicesPaymentView } from "./services-view";

const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const line = { itemId: z.string().min(1).max(300), side: z.enum(["baseline", "proposed"]), contentHash: hash, revisionContentHash: hash };
const cents = z.number().int().min(0).max(2_000_000_000);
/** How the client pays: PayPal in a popup window, a full-page PayPal redirect (fallback), the Sandbox test card, or the saved method. */
const via = z.enum(["popup", "redirect", "test_card", "saved"]);
const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("authorize"), ...line, via: via.optional(), save: z.boolean().optional() }),
  z.strictObject({ action: z.literal("hold_saved") }),
  z.strictObject({ action: z.literal("remove_saved") }),
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
  z.strictObject({ action: z.literal("fees") }),
]);
const servicesSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("checkout"), save: z.boolean().optional() }),
  z.strictObject({ action: z.literal("test_card"), save: z.boolean().optional() }),
  z.strictObject({ action: z.literal("remove_saved") }),
  z.strictObject({ action: z.literal("approve"), operationId: uuid }),
  z.strictObject({ action: z.literal("cancel"), operationId: uuid }),
  z.strictObject({ action: z.literal("check"), operationId: uuid }),
  z.strictObject({ action: z.literal("charge") }),
]);
const holdSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("hold") }),
  z.strictObject({ action: z.literal("remove_saved") }),
  z.strictObject({ action: z.literal("checkout"), itemId: z.string().min(1).max(300), via: z.enum(["popup", "test_card"]), save: z.boolean().optional() }),
  z.strictObject({
    action: z.literal("supplier_order"), itemId: z.string().min(1).max(300), contentHash: hash, quantity: z.number().int().min(1).max(10_000), unitPriceCents: cents, taxCents: cents, freightCents: cents,
    inStock: z.boolean(), leadTimeDays: z.number().int().min(0).max(3_650).nullable(), reference: z.string().trim().min(1).max(200), note: z.string().trim().max(1_000),
  }),
  z.strictObject({ action: z.literal("capture"), itemId: z.string().min(1).max(300), contentHash: hash }),
  z.strictObject({ action: z.literal("check"), operationId: uuid }),
  z.strictObject({ action: z.literal("cancel"), operationId: uuid }),
  z.strictObject({ action: z.literal("cancel_item"), itemId: z.string().min(1).max(300), side: z.enum(["baseline", "proposed"]).optional(), reason: z.enum(CANCELLATION_REASONS), note: z.string().trim().max(1_000) }),
]);
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }

const db = appDb;

/** The signed-in actor's scope in project `key`, or the refusal to send. */
async function scoped(req: NextRequest, key: CaseKey): Promise<ProjectScope | NextResponse> {
  const scope = await projectScope(req, key);
  if (isRefusal(scope)) return refusalResponse(scope, headers);
  noteRequest(scope.sessionId);
  return scope;
}

/** PayPal sends the buyer back here; SETTI_PUBLIC_URL overrides the request origin when the app runs behind a proxy. */
export function paypalLinks(req: NextRequest): LinkBuilder {
  const origin = process.env.SETTI_PUBLIC_URL?.trim() || requestOrigin(req);
  if (!origin) throw new HttpError("The request host is invalid.", 400);
  const base = origin.replace(/\/$/, "");
  return (operationId) => ({
    returnUrl: `${base}/api/payments/paypal/return?op=${operationId}&state=${callbackState(operationId, "return")}`,
    cancelUrl: `${base}/api/payments/paypal/cancel?op=${operationId}&state=${callbackState(operationId, "cancel")}`,
  });
}

async function boundedJson(req: NextRequest): Promise<unknown> {
  if (!isSameOriginRequest(req)) throw new HttpError("Payment steps must be started from this app's pages.", 403);
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

async function pendingPreparation(sessionId: string, key: CaseKey) {
  return await paymentPreparationPending(db(), sessionId, key)
    ? NextResponse.json({ code: "PREPARATION_PENDING", error: PREPARATION_MESSAGE }, { status: 409, headers }) : null;
}

/** After the client confirms a version: its new items are held with the saved method and the client hands over in the chat. */
export async function afterClientConfirmed(req: NextRequest, sessionId: string, key: CaseKey, orderId: string): Promise<void> {
  if (await pendingPreparation(sessionId, key)) return;
  await afterVersionConfirmed(db(), sandboxPayPal(), sessionId, key, orderId, paypalLinks(req));
}

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
    // Someone outside the project reads the share link like anyone else: no payment steps.
    const { owner, account } = await orderScope(req, id);
    if (owner && account) noteRequest(owner.studioId);
    const workspace = await paymentsWorkspace(db(), owner && account ? owner.studioId : null, id, undefined, account, demoCheckout());
    return workspace ? NextResponse.json(workspace, { headers }) : NextResponse.json({ code: "NOT_FOUND", error: "This change order could not be found." }, { status: 404, headers });
  } catch (error) { return fail(error); }
}

export async function postPaymentsResponse(req: NextRequest, id: string) {
  if (!uuid.safeParse(id).success) return NextResponse.json({ code: "NOT_FOUND", error: "This change order could not be found." }, { status: 404, headers });
  try {
    const { actor, owner, account } = await orderScope(req, id);
    if (!actor) return refusalResponse(SIGN_IN_REQUIRED, headers);
    const input = actionSchema.parse(await boundedJson(req));
    if (!owner) return NextResponse.json({ code: "NOT_FOUND", error: "This change order could not be found." }, { status: 404, headers });
    if (!account) return refusalResponse(NOT_YOUR_PROJECT, headers);
    const sessionId = owner.studioId;
    noteRequest(sessionId);
    const ended = await refuseIfEnded(sessionId);
    if (ended) return ended;
    const workspace = await paymentsWorkspace(db(), sessionId, id, undefined, account);
    if (!workspace) return NextResponse.json({ code: "NOT_FOUND", error: "This change order could not be found." }, { status: 404, headers });
    const preparing = await pendingPreparation(sessionId, workspace.projectKey);
    if (preparing) return preparing;
    const client = account.role === "client";
    if (["authorize", "hold_saved", "remove_saved"].includes(input.action) && !client) return NextResponse.json({ code: "FORBIDDEN", error: "Only this project's client pays or changes the saved payment method." }, { status: 403, headers });
    if (input.action === "authorize" && input.via === "test_card" && !demoCheckout().testCard) return NextResponse.json({ code: "FORBIDDEN", error: "The Sandbox test card is turned off on this server." }, { status: 403, headers });
    if (["capture", "release", "refund", "supplier_order", "supplier_credit"].includes(input.action) && account.role !== "designer") return NextResponse.json({ code: "FORBIDDEN", error: "Only the designer records supplier confirmations, captures, releases and refunds." }, { status: 403, headers });
    if (input.action === "check" || input.action === "cancel") {
      const operation = workspace.operations.find((entry) => entry.id === input.operationId);
      if (!operation) return NextResponse.json({ code: "NOT_FOUND", error: "This payment step does not belong to this project." }, { status: 404, headers });
      if ((input.action === "check" && operation.kind !== "authorize" && account.role !== "designer") || (input.action === "cancel" && !client)) return NextResponse.json({ code: "FORBIDDEN", error: "Switch to the account responsible for this payment step." }, { status: 403, headers });
    }
    let operationId: string | null = null, redirectUrl: string | null = null, paypalOrderId: string | null = null;
    switch (input.action) {
      case "authorize": {
        const how = input.via ?? "redirect";
        let operation = await startAuthorization(db(), sandboxPayPal(), sessionId, id, input, paypalLinks(req), { via: how === "saved" ? "saved" : "checkout", save: input.save });
        if (how === "test_card" && !operation.savedMethodId) operation = (await approveCheckoutWithTestCard(db(), sandboxPayPal(), sandboxTestCard(), operation)).operation;
        operationId = operation.id;
        const awaitingBuyer = operation.status === "pending" && !operation.paypalResourceId && !operation.savedMethodId;
        paypalOrderId = awaitingBuyer ? operation.paypalOrderId : null;
        redirectUrl = awaitingBuyer && how === "redirect" ? operation.approvalUrl : null;
        break;
      }
      case "hold_saved":
        if (!workspace.current) return NextResponse.json({ code: "STALE_VERSION", error: "Hold items from the latest confirmed version." }, { status: 409, headers });
        await holdApprovedItems(db(), sandboxPayPal(), sessionId, workspace.projectKey, paypalLinks(req));
        break;
      case "remove_saved":
        await removeCaseSavedMethod(db(), sandboxPayPal(), sessionId, workspace.projectKey);
        break;
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
        operationId = (await checkPayment(db(), sandboxPayPal(), sessionId, id, input.operationId, paypalLinks(req))).id;
        break;
      case "cancel":
        operationId = (await cancelPayment(db(), sandboxPayPal(), sessionId, id, input.operationId)).id;
        break;
      case "fees":
        await refreshRecordedFees(db(), sandboxPayPal(), sessionId, id);
        break;
    }
    return NextResponse.json({ workspace: await paymentsWorkspace(db(), sessionId, id, undefined, account, demoCheckout()), operationId, redirectUrl, paypalOrderId }, { headers });
  } catch (error) { return fail(error); }
}

/** PayPal redirects the buyer here after approving (`return`) or leaving (`cancel`). */
export async function paypalRedirectResponse(req: NextRequest, outcome: "return" | "cancel") {
  const operationId = uuid.safeParse(req.nextUrl.searchParams.get("op"));
  const origin = requestOrigin(req) ?? req.nextUrl.origin;
  // A return Setti cannot place goes to the demo home; "/" is the public landing page.
  const home = new URL("/try", origin);
  if (!operationId.success) return NextResponse.redirect(home, 303);
  let target: Awaited<ReturnType<typeof operationPage>> = null;
  const page = (state: string) => {
    if (!target) return NextResponse.redirect(home, 303);
    const url = new URL(target.path, origin);
    url.searchParams.set("paypal", state);
    url.hash = target.anchor;
    return NextResponse.redirect(url, 303);
  };
  try {
    if (!validCallbackState(operationId.data, outcome, req.nextUrl.searchParams.get("state"))) return NextResponse.redirect(home, 303);
    target = await operationPage(db(), operationId.data);
    const result = await returnFromPayPal(db(), sandboxPayPal(), operationId.data, req.nextUrl.searchParams.get("token"), outcome);
    if (!result) return page("unmatched");
    // An authorized design-services hold is charged and the furniture held right away; the page can finish it if this stops early.
    if (result.servicesHold && result.state === "authorized" && target?.projectKey) await afterServicesPaid(db(), sandboxPayPal(), target.studioId, target.projectKey, paypalLinks(req)).catch(() => null);
    return page(outcome === "cancel" && result.state === "failed" ? "cancelled" : result.state);
  } catch {
    // The page offers "Check PayPal status", which reads the real outcome again.
    return page("unknown");
  }
}

function paypalClientId(): string | null {
  try { return assertSandbox().clientId; } catch { return null; }
}

/**
 * The demo payment choices: PayPal's documented Sandbox test card (unless
 * SETTI_DEMO_TEST_CARD=off) and the Sandbox buyer login, shown next to the PayPal
 * window when SANDBOX_BUYER_EMAIL and SANDBOX_BUYER_PASSWORD are set.
 */
function demoCheckout(): DemoCheckout {
  const email = process.env.SANDBOX_BUYER_EMAIL?.trim(), password = process.env.SANDBOX_BUYER_PASSWORD?.trim();
  return { paypalClientId: paypalClientId(), testCard: process.env.SETTI_DEMO_TEST_CARD?.trim().toLowerCase() !== "off", sandboxBuyer: email && password ? { email, password } : null };
}

function servicesView(scope: ProjectScope, key: CaseKey) {
  const { paypalClientId: clientId, ...demo } = demoCheckout();
  return servicesPaymentView(db(), scope.sessionId, key, scope.account, clientId, demo);
}

/** The design-services payment of the project's current agreement. */
export async function getServicesPaymentResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404, headers });
  const scope = await scoped(req, rawKey);
  if (scope instanceof NextResponse) return scope;
  try { return NextResponse.json(await servicesView(scope, rawKey), { headers }); }
  catch (error) { return fail(error); }
}

/**
 * The client pays the approved design services: one PayPal checkout (PayPal or
 * Pay Later), then each service is captured from the hold. Either account of
 * the project may finish charging a hold the client already approved.
 */
export async function postServicesPaymentResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404, headers });
  const scope = await scoped(req, rawKey);
  if (scope instanceof NextResponse) return scope;
  const { sessionId, account } = scope;
  const ended = await refuseIfEnded(sessionId);
  if (ended) return ended;
  try {
    const input = servicesSchema.parse(await boundedJson(req));
    const client = account.role === "client";
    const preparing = await pendingPreparation(sessionId, rawKey);
    if (preparing) return preparing;
    if (input.action !== "charge" && input.action !== "check" && !client) return NextResponse.json({ code: "FORBIDDEN", error: "Only the client pays the design services. Switch to the client's account first." }, { status: 403, headers });
    if (input.action === "test_card" && !demoCheckout().testCard) return NextResponse.json({ code: "FORBIDDEN", error: "The Sandbox test card is turned off on this server." }, { status: 403, headers });
    const paypal = sandboxPayPal();
    let paypalOrderId: string | null = null, operationId: string | null = null;
    switch (input.action) {
      case "checkout": {
        const operation = await startServicesCheckout(db(), paypal, sessionId, rawKey, paypalLinks(req), { save: input.save });
        operationId = operation.id;
        paypalOrderId = operation.status === "pending" && !operation.paypalResourceId ? operation.paypalOrderId : null;
        break;
      }
      case "test_card": {
        const started = await startServicesCheckout(db(), paypal, sessionId, rawKey, paypalLinks(req), { save: input.save });
        const { operation, state } = await approveCheckoutWithTestCard(db(), paypal, sandboxTestCard(), started);
        operationId = operation.id;
        if (state === "authorized") await afterServicesPaid(db(), paypal, sessionId, rawKey, paypalLinks(req));
        break;
      }
      case "remove_saved":
        await removeCaseSavedMethod(db(), paypal, sessionId, rawKey);
        break;
      case "approve": {
        await servicesOperation(sessionId, rawKey, input.operationId);
        const { state } = await completeAuthorization(db(), paypal, input.operationId);
        if (state === "authorized") await afterServicesPaid(db(), paypal, sessionId, rawKey, paypalLinks(req));
        break;
      }
      case "cancel":
        await servicesOperation(sessionId, rawKey, input.operationId);
        // PayPal may report the order approved after all; then it is settled like an approval.
        if ((await cancelCheckout(db(), paypal, input.operationId)).state === "authorized") await afterServicesPaid(db(), paypal, sessionId, rawKey, paypalLinks(req));
        break;
      case "check": {
        const result = await checkServicesCheckout(db(), paypal, sessionId, rawKey, input.operationId, paypalLinks(req));
        if (result.state === "authorized") await afterServicesPaid(db(), paypal, sessionId, rawKey, paypalLinks(req));
        operationId = result.operation.id;
        paypalOrderId = result.operation.paypalOrderId;
        break;
      }
      case "charge":
        await afterServicesPaid(db(), paypal, sessionId, rawKey, paypalLinks(req));
        break;
    }
    return NextResponse.json({ view: await servicesView(scope, rawKey), operationId, paypalOrderId }, { headers });
  } catch (error) { return fail(error); }
}

function holdsView(scope: ProjectScope, key: CaseKey) {
  return itemHoldsView(db(), scope.sessionId, key, scope.account, demoCheckout());
}

/** The approved furniture items of the project's current agreement and their PayPal holds. */
export async function getItemHoldsResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404, headers });
  const scope = await scoped(req, rawKey);
  if (scope instanceof NextResponse) return scope;
  try { return NextResponse.json(await holdsView(scope, rawKey), { headers }); }
  catch (error) { return fail(error); }
}

/**
 * Holds each approved furniture item with the client's saved PayPal (either account of the
 * project). On V1 the designer also records the supplier's confirmation and captures here.
 */
export async function postItemHoldsResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404, headers });
  const scope = await scoped(req, rawKey);
  if (scope instanceof NextResponse) return scope;
  const { sessionId, account } = scope;
  const ended = await refuseIfEnded(sessionId);
  if (ended) return ended;
  try {
    const input = holdSchema.parse(await boundedJson(req));
    const preparing = await pendingPreparation(sessionId, rawKey);
    if (preparing) return preparing;
    if ((input.action === "supplier_order" || input.action === "capture") && account.role !== "designer") return NextResponse.json({ code: "FORBIDDEN", error: "Only the designer records supplier confirmations and captures." }, { status: 403, headers });
    if (input.action === "cancel_item" && account.role !== "designer") return NextResponse.json({ code: "FORBIDDEN", error: "Only the designer cancels an item. The client can ask for it in the chat." }, { status: 403, headers });
    if ((input.action === "cancel" || input.action === "remove_saved" || input.action === "checkout") && account.role !== "client") return NextResponse.json({ code: "FORBIDDEN", error: "Only the client pays, leaves a PayPal checkout or removes the saved payment method." }, { status: 403, headers });
    if (input.action === "checkout" && input.via === "test_card" && !demoCheckout().testCard) return NextResponse.json({ code: "FORBIDDEN", error: "The Sandbox test card is turned off on this server." }, { status: 403, headers });
    let attempted = 0, operationId: string | null = null, paypalOrderId: string | null = null;
    switch (input.action) {
      case "hold":
        attempted = (await holdApprovedItems(db(), sandboxPayPal(), sessionId, rawKey, paypalLinks(req))).length;
        break;
      case "supplier_order":
        await recordOpeningSupplierOrder(db(), sessionId, rawKey, input);
        break;
      case "capture":
        attempted = (await startOpeningCapture(db(), sandboxPayPal(), sessionId, rawKey, input)).length;
        break;
      case "check":
        await checkItemHold(db(), sandboxPayPal(), sessionId, rawKey, input.operationId, paypalLinks(req));
        break;
      case "checkout": {
        let operation = await startItemCheckout(db(), sandboxPayPal(), sessionId, rawKey, input.itemId, paypalLinks(req), { save: input.save });
        if (input.via === "test_card") operation = (await approveCheckoutWithTestCard(db(), sandboxPayPal(), sandboxTestCard(), operation)).operation;
        operationId = operation.id;
        paypalOrderId = operation.status === "pending" && !operation.paypalResourceId ? operation.paypalOrderId : null;
        break;
      }
      case "cancel":
        await cancelItemHold(db(), sandboxPayPal(), sessionId, rawKey, input.operationId);
        break;
      case "remove_saved":
        await removeCaseSavedMethod(db(), sandboxPayPal(), sessionId, rawKey);
        break;
      case "cancel_item":
        attempted = (await cancelApprovedItem(db(), sandboxPayPal(), sessionId, rawKey, { ...input, by: account.name })).operations.length;
        break;
    }
    return NextResponse.json({ view: await holdsView(scope, rawKey), attempted, operationId, paypalOrderId }, { headers });
  } catch (error) { return fail(error); }
}

/** The designer's reminders across the studio's projects. Clients have their own steps on each page. */
export async function getAttentionResponse(req: NextRequest) {
  const scope = await studioScope(req);
  if (isRefusal(scope)) return refusalResponse(scope.status === 403 ? { ...scope, error: "Only the designer sees the studio's reminders." } : scope, headers);
  noteRequest(scope.sessionId);
  try { return NextResponse.json(await attentionView(db(), scope.sessionId, scope.account), { headers }); }
  catch (error) { return fail(error); }
}

/**
 * The daily check, called once a day by the host's scheduler with the job secret
 * (SETTI_JOB_SECRET). Without the secret configured, the endpoint stays closed.
 */
export async function postDailyCheckResponse(req: NextRequest) {
  const secret = process.env.SETTI_JOB_SECRET?.trim();
  if (!secret) return NextResponse.json({ code: "NOT_CONFIGURED", error: "The daily check is not configured on this server." }, { status: 503, headers });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return NextResponse.json({ code: "FORBIDDEN", error: "The job secret is missing or wrong." }, { status: 401, headers });
  try { return NextResponse.json(await runDailyCheck(db(), sandboxPayPal()), { headers }); }
  catch (error) { return fail(error); }
}

/**
 * PayPal's webhook: each event is kept only once PayPal verifies its signature
 * (PAYPAL_WEBHOOK_ID names the webhook registered for this server). Without a
 * webhook id the endpoint stays closed. An event confirms records; it never moves money.
 */
export async function postPayPalWebhookResponse(req: NextRequest, verifier: WebhookVerifier | null = paypalWebhookVerifier()) {
  if (!verifier) return NextResponse.json({ code: "NOT_CONFIGURED", error: "PayPal webhooks are not configured on this server." }, { status: 503, headers });
  const body = await req.text();
  if (body.length > 64_000) return NextResponse.json({ code: "INVALID_REQUEST", error: "The webhook event is too large." }, { status: 413, headers });
  let event: unknown;
  try { event = JSON.parse(body); } catch { return NextResponse.json({ code: "INVALID_REQUEST", error: "The webhook event is not JSON." }, { status: 400, headers }); }
  if (!await verifier({ headers: req.headers, event })) return NextResponse.json({ code: "FORBIDDEN", error: "PayPal did not verify this event's signature." }, { status: 400, headers });
  try { return NextResponse.json({ received: true, ...await recordWebhookEvent(db(), event) }, { headers }); }
  catch (error) { return fail(error); }
}

/** PayPal for reading records back, or null when the server has no Sandbox credentials: the inbox then shows recorded checks only. */
function readablePayPal() {
  try { return sandboxPayPal(); } catch { return null; }
}

/** Where the signed-in actor's inbox and demo clock read from, or the refusal to send. */
async function home(req: NextRequest): Promise<ReturnType<typeof homeOf> & { actor: Actor } | NextResponse> {
  const actor = await requestActor(req);
  if (!actor) return refusalResponse(SIGN_IN_REQUIRED, headers);
  const found = homeOf(actor);
  noteRequest(found.sessionId);
  return { ...found, actor };
}

/** The signed-in account's payment inbox: the designer's reminders, or the client's money with PayPal's latest confirmations. */
export async function getInboxResponse(req: NextRequest) {
  const scope = await home(req);
  if (scope instanceof NextResponse) return scope;
  try { return NextResponse.json(await inboxView(db(), readablePayPal(), scope.sessionId, scope.account), { headers }); }
  catch (error) { return fail(error); }
}

/** The number on the sidebar's Inbox: the designer's open reminders, or the client's money records not seen yet. */
export async function getInboxBadgeResponse(req: NextRequest) {
  const scope = await home(req);
  if (scope instanceof NextResponse) return scope;
  try { return NextResponse.json(await inboxBadge(db(), scope.sessionId, scope.account), { headers }); }
  catch (error) { return fail(error); }
}

const seenSchema = z.strictObject({ through: z.iso.datetime() });

/** The reader opened the inbox: what it showed, read at `through`, is no longer new. */
export async function postInboxSeenResponse(req: NextRequest) {
  const scope = await home(req);
  if (scope instanceof NextResponse) return scope;
  try {
    const input = seenSchema.parse(await boundedJson(req));
    // A client with no project yet has nothing to mark.
    if (scope.sessionId) await markInboxOpened(db(), scope.sessionId, scope.account, new Date(input.through));
    return NextResponse.json({ seen: true }, { headers });
  } catch (error) { return fail(error); }
}

/** The AI summary on top of the inbox, written from the same facts and checked against them; cached per set of facts. */
export async function getInboxSummaryResponse(req: NextRequest) {
  const scope = await home(req);
  if (scope instanceof NextResponse) return scope;
  const { sessionId, account } = scope;
  if (!sessionId) return NextResponse.json({ code: "NOT_FOUND", error: "There is nothing in this inbox yet." }, { status: 404, headers });
  try {
    const view = await inboxView(db(), null, sessionId, account);
    return NextResponse.json(await summarizeInbox(db(), sessionId, { audience: view.role, reader: `${view.reader} (the ${view.role})`, facts: inboxFacts(view) }, undefined,
      () => takeAiAllowance(scope.actor, db)), { headers });
  } catch (error) { return fail(error); }
}

const clockSchema = z.strictObject({ days: z.number().int().min(1).max(MAX_SKIP_DAYS) });

/** How far the actor's demo studio has skipped ahead. */
export async function getDemoClockResponse(req: NextRequest) {
  const scope = await home(req);
  if (scope instanceof NextResponse) return scope;
  try { return NextResponse.json({ days: await demoDays(db(), scope.sessionId) }, { headers }); }
  catch (error) { return fail(error); }
}

/**
 * The designer skips this demo session ahead to a later day: the daily check runs
 * for each day passed, so reminders, renewal notices and renewals happen as they
 * would. PayPal calls are real Sandbox calls; only the day Setti judges by moves.
 */
export async function postDemoClockResponse(req: NextRequest) {
  const scope = await studioScope(req);
  if (isRefusal(scope)) return refusalResponse(scope.status === 403 ? { ...scope, error: "The designer skips ahead in the demo." } : scope, headers);
  const { sessionId } = scope;
  noteRequest(sessionId);
  const ended = await refuseIfEnded(sessionId);
  if (ended) return ended;
  try {
    const input = clockSchema.parse(await boundedJson(req));
    const { days, runs } = await skipAhead(db(), sandboxPayPal(), sessionId, input.days);
    return NextResponse.json({
      days, checks: runs.length,
      notices: runs.reduce((total, run) => total + run.notices, 0),
      renewals: runs.reduce((total, run) => total + run.renewals, 0),
      problems: runs.flatMap((run) => run.problems),
    }, { headers });
  } catch (error) {
    if (error instanceof DemoClockError) return NextResponse.json({ code: "INVALID_REQUEST", error: error.message }, { status: 400, headers });
    return fail(error);
  }
}

/** The design-services checkout must belong to this studio's project. */
async function servicesOperation(sessionId: string, key: CaseKey, operationId: string): Promise<void> {
  const owned = await db().transaction(async (tx) => (await lockPaymentBasis(tx, sessionId, key)).ledger.operations.some((operation) => operation.id === operationId && operation.servicesHold));
  if (!owned) throw new PaymentActionError("NOT_FOUND", "This design-services checkout does not belong to this project.");
}
