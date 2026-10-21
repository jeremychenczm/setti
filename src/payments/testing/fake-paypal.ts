/**
 * A fake PayPal for tests. Its answers are shaped from the sandbox calls
 * recorded in probes/recorded, and it honours request ids the way PayPal does:
 * a request id it has already processed gets the original result back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuthorizationReceipt, AuthorizeOrderCommand, CaptureCommand, CaptureReceipt, CreateOrderCommand, OrderReceipt,
  PayPalPayments, PayPalResult, RefundCommand, RefundReceipt, VoidCommand,
} from "../paypal";

interface RecordedStep {
  step: string;
  ok: boolean;
  statusCode?: number;
  debugId?: string;
  response?: { id: string; status: string; amount?: { value: string } };
  error?: { message: string; debug_id?: string; details?: { issue: string }[] };
}

function recorded(file: string, pick: (step: RecordedStep) => boolean): RecordedStep {
  const recording = JSON.parse(readFileSync(join(process.cwd(), "probes", "recorded", file), "utf8")) as { steps: RecordedStep[] };
  const step = recording.steps.find(pick);
  if (!step) throw new Error(`No matching step in ${file}`);
  return step;
}

const recordedOrder = recorded("p1-standing-authorization-wallet-d-2026-10-18.json", (s) => s.step.startsWith("create"));
const recordedAuthorization = recorded("p1-standing-authorization-wallet-d-2026-10-18.json", (s) => s.step.startsWith("authorize"));
const recordedCapture = recorded("p2-multiple-partial-captures-vault-g-aged-2026-10-18.json", (s) => s.step.startsWith("capture 1"));
const recordedAlreadyCaptured = recorded("p2-multiple-partial-captures-vault-g-aged-2026-10-18.json", (s) => !s.ok);
const recordedOverLimit = recorded("p3-over-capture-vault-b-aged-vault-c-aged-2026-10-18.json", (s) => !s.ok);
const recordedVoid = recorded("p9-void-after-partial-vault-d-aged-2026-10-18.json", (s) => s.step.startsWith("void"));

/**
 * What the next write call does:
 * - `succeed`: PayPal does it and answers with the full resource.
 * - `reject-over-limit`: refused with the recorded MAX_CAPTURE_AMOUNT_EXCEEDED error.
 * - `reject-already-captured`: refused with the recorded AUTHORIZATION_ALREADY_CAPTURED error.
 * - `reject-expired`: refused with AUTHORIZATION_EXPIRED, as PayPal's negative testing returns it.
 * - `lose-response`: PayPal does it, but the answer never arrives (a timeout).
 * - `time-out`: the call times out before PayPal processes it.
 * - `answer-pending`: PayPal does it but reports the money as PENDING.
 * - `answer-declined`: PayPal answers with a DECLINED capture.
 * - `answer-minimal`: PayPal does it but answers without status, amount or currency.
 * - `answer-other-amount`: PayPal does it but reports a different amount.
 */
export type FakeBehaviour =
  | "succeed" | "reject-over-limit" | "reject-already-captured" | "reject-expired" | "lose-response" | "time-out"
  | "answer-pending" | "answer-declined" | "answer-minimal" | "answer-other-amount";

const TIMEOUT = { kind: "unknown", message: "Timed out waiting for PayPal" } as const;
const usd = (amountCents: number) => ({ amountCents, currency: "USD" });

function rejection(step: RecordedStep, fallback: string): PayPalResult<never> {
  const error = step.error!;
  return { kind: "rejected", code: error.details?.[0]?.issue ?? fallback, message: error.message, debugId: error.debug_id, trace: { httpStatus: step.statusCode, debugId: error.debug_id } };
}

function refuse(code: string, message: string): PayPalResult<never> {
  return { kind: "rejected", code, message, trace: { httpStatus: 422 } };
}

const EXPIRED = refuse("AUTHORIZATION_EXPIRED", "The requested action could not be performed, semantically incorrect, or failed business validation.");

interface FakeOrder { receipt: OrderReceipt; approved: boolean; authorizationId?: string }
interface FakeHold { receipt: AuthorizationReceipt; capturedCents: number }

export class FakePayPal implements PayPalPayments {
  /** Write calls, in order, with the command PayPal received. */
  readonly calls: (CaptureCommand | VoidCommand | RefundCommand | CreateOrderCommand | AuthorizeOrderCommand)[] = [];
  /** Read calls, in order. */
  readonly reads: string[] = [];
  private readonly plan: FakeBehaviour[] = [];
  private readonly answered = new Map<string, PayPalResult<unknown>>();
  private readonly orders = new Map<string, FakeOrder>();
  private readonly holds = new Map<string, FakeHold>();
  private readonly captures = new Map<string, CaptureReceipt>();
  private readonly refunds = new Map<string, RefundReceipt>();
  private nextId = 1;
  /** When set, reads fail as if PayPal could not be reached. */
  readsUnavailable = false;

  /** Queues behaviours for the next write calls; once the queue is empty, calls succeed. */
  then(...behaviours: FakeBehaviour[]): this {
    this.plan.push(...behaviours);
    return this;
  }

  /** The buyer approves the order on PayPal. */
  approve(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown fake order ${orderId}`);
    order.approved = true;
    order.receipt = { ...order.receipt, status: "APPROVED" };
  }

  /** The hold PayPal keeps for an authorization id, if this fake created it. */
  hold(paypalAuthorizationId: string): AuthorizationReceipt | undefined {
    return this.holds.get(paypalAuthorizationId)?.receipt;
  }

  async createOrder(command: CreateOrderCommand): Promise<PayPalResult<OrderReceipt>> {
    return this.write(command, `order:${command.requestId}`, (behaviour) => {
      const orderId = `${recordedOrder.response!.id.slice(0, 10)}${String(this.nextId++).padStart(7, "0")}`;
      const receipt: OrderReceipt = {
        orderId, status: recordedOrder.response!.status, ...usd(command.amountCents), customId: command.customId,
        approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
      };
      this.orders.set(orderId, { receipt, approved: false });
      return behaviour === "answer-minimal" ? { orderId, status: receipt.status } : receipt;
    });
  }

  async getOrder(orderId: string): Promise<PayPalResult<OrderReceipt>> {
    return this.read(orderId, () => this.orders.get(orderId)?.receipt);
  }

  async authorizeOrder(command: AuthorizeOrderCommand): Promise<PayPalResult<OrderReceipt>> {
    return this.write(command, `authorize:${command.requestId}`, (behaviour) => {
      const order = this.orders.get(command.orderId);
      if (!order || !order.approved) return refuse("ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.");
      const authorizationId = order.authorizationId ?? `${recordedAuthorization.response!.id.slice(0, 10)}${String(this.nextId++).padStart(7, "0")}`;
      const amountCents = behaviour === "answer-other-amount" ? order.receipt.amountCents! + 1 : order.receipt.amountCents!;
      const created = new Date();
      const auth: AuthorizationReceipt = {
        paypalAuthorizationId: authorizationId, status: behaviour === "answer-pending" ? "PENDING" : "CREATED", ...usd(amountCents),
        orderId: command.orderId, customId: order.receipt.customId, createTime: created.toISOString(),
        expirationTime: new Date(created.getTime() + 29 * 86_400_000).toISOString(),
      };
      order.authorizationId = authorizationId;
      this.holds.set(authorizationId, { receipt: auth, capturedCents: 0 });
      order.receipt = { ...order.receipt, status: "COMPLETED", authorization: auth };
      return behaviour === "answer-minimal" ? { orderId: command.orderId, status: "COMPLETED" } : order.receipt;
    });
  }

  async getAuthorization(id: string): Promise<PayPalResult<AuthorizationReceipt>> {
    return this.read(id, () => this.holds.get(id)?.receipt);
  }

  async captureAuthorization(command: CaptureCommand): Promise<PayPalResult<CaptureReceipt>> {
    return this.write(command, `capture:${command.requestId}`, (behaviour) => {
      if (behaviour === "reject-over-limit") return rejection(recordedOverLimit, "UNPROCESSABLE_ENTITY");
      if (behaviour === "reject-already-captured") return rejection(recordedAlreadyCaptured, "UNPROCESSABLE_ENTITY");
      if (behaviour === "reject-expired") return EXPIRED;
      const status = behaviour === "answer-pending" ? "PENDING" : behaviour === "answer-declined" ? "DECLINED" : recordedCapture.response!.status;
      const receipt: CaptureReceipt = {
        paypalCaptureId: `${recordedCapture.response!.id}-${this.nextId++}`, status,
        ...usd(behaviour === "answer-other-amount" ? command.amountCents + 1 : command.amountCents),
        finalCapture: command.finalCapture, createTime: new Date().toISOString(),
      };
      // What PayPal keeps: a minimal answer leaves out fields it still has; a different amount is really different.
      this.captures.set(receipt.paypalCaptureId!, { ...receipt, status: behaviour === "answer-minimal" ? recordedCapture.response!.status : status });
      const hold = this.holds.get(command.paypalAuthorizationId);
      if (hold && status !== "DECLINED") {
        hold.capturedCents += command.amountCents;
        hold.receipt = { ...hold.receipt, status: command.finalCapture ? "CAPTURED" : "PARTIALLY_CAPTURED" };
      }
      return behaviour === "answer-minimal" ? { paypalCaptureId: receipt.paypalCaptureId } : receipt;
    });
  }

  async getCapture(id: string): Promise<PayPalResult<CaptureReceipt>> {
    return this.read(id, () => this.captures.get(id));
  }

  /** PayPal reports a pending capture as settled (completed or declined). */
  settleCapture(id: string, status: "COMPLETED" | "DECLINED"): void {
    const capture = this.captures.get(id);
    if (!capture) throw new Error(`Unknown fake capture ${id}`);
    this.captures.set(id, { ...capture, status });
  }

  async voidAuthorization(command: VoidCommand): Promise<PayPalResult<AuthorizationReceipt>> {
    return this.write(command, `void:${command.requestId}`, (behaviour) => {
      // Recorded on a capture after the final one; PayPal refuses a void of a fully captured hold the same way.
      if (behaviour === "reject-already-captured") return rejection(recordedAlreadyCaptured, "UNPROCESSABLE_ENTITY");
      if (behaviour === "reject-over-limit") return rejection(recordedOverLimit, "UNPROCESSABLE_ENTITY");
      if (behaviour === "reject-expired") return EXPIRED;
      const hold = this.holds.get(command.paypalAuthorizationId);
      const reported = Math.round(Number(recordedVoid.response?.amount?.value ?? "0") * 100);
      const receipt: AuthorizationReceipt = { ...(hold?.receipt ?? { paypalAuthorizationId: command.paypalAuthorizationId, ...usd(reported) }), status: recordedVoid.response!.status };
      if (hold) hold.receipt = receipt;
      else this.holds.set(command.paypalAuthorizationId, { receipt, capturedCents: 0 });
      return behaviour === "answer-minimal" ? {} : receipt;
    });
  }

  async refundCapture(command: RefundCommand): Promise<PayPalResult<RefundReceipt>> {
    return this.write(command, `refund:${command.requestId}`, (behaviour) => {
      const refunded = [...this.refunds.values()].filter((refund) => refund.status !== "FAILED" && refund.status !== "CANCELLED" && (refund as RefundReceipt & { captureId?: string }).captureId === command.paypalCaptureId)
        .reduce((total, refund) => total + (refund.amountCents ?? 0), 0);
      const capture = this.captures.get(command.paypalCaptureId);
      if (capture && refunded + command.amountCents > capture.amountCents!) {
        return refuse("REFUND_AMOUNT_EXCEEDED", "The refund amount must be less than or equal to the capture amount that has not yet been refunded.");
      }
      const receipt: RefundReceipt = {
        paypalRefundId: `REFUND-${this.nextId++}`, status: behaviour === "answer-pending" ? "PENDING" : "COMPLETED",
        ...usd(behaviour === "answer-other-amount" ? command.amountCents + 1 : command.amountCents), createTime: new Date().toISOString(),
      };
      this.refunds.set(receipt.paypalRefundId!, { ...receipt, captureId: command.paypalCaptureId } as RefundReceipt);
      return behaviour === "answer-minimal" ? { paypalRefundId: receipt.paypalRefundId } : receipt;
    });
  }

  async getRefund(id: string): Promise<PayPalResult<RefundReceipt>> {
    return this.read(id, () => this.refunds.get(id));
  }

  /** PayPal reports a pending refund as settled. */
  settleRefund(id: string, status: "COMPLETED" | "FAILED"): void {
    const refund = this.refunds.get(id);
    if (!refund) throw new Error(`Unknown fake refund ${id}`);
    this.refunds.set(id, { ...refund, status });
  }

  /**
   * One write call: a request id PayPal has already processed gets its original
   * answer back (unless this attempt times out before reaching PayPal).
   */
  private async write<T>(command: CaptureCommand | VoidCommand | RefundCommand | CreateOrderCommand | AuthorizeOrderCommand, key: string, act: (behaviour: FakeBehaviour) => T | PayPalResult<never>): Promise<PayPalResult<T>> {
    this.calls.push(command);
    const behaviour = this.plan.shift() ?? "succeed";
    if (behaviour === "time-out") return TIMEOUT;
    const already = this.answered.get(key) as PayPalResult<T> | undefined;
    if (already) return already;
    const outcome = act(behaviour);
    const result: PayPalResult<T> = isResult(outcome) ? outcome : { kind: "ok", value: outcome, trace: { httpStatus: 201, debugId: `fake-${this.nextId++}` } };
    if (result.kind === "ok") this.answered.set(key, result);
    return behaviour === "lose-response" ? TIMEOUT : result;
  }

  private async read<T>(id: string, find: () => T | undefined): Promise<PayPalResult<T>> {
    this.reads.push(id);
    if (this.readsUnavailable) return TIMEOUT;
    const value = find();
    return value ? { kind: "ok", value: structuredClone(value), trace: { httpStatus: 200 } } : { kind: "rejected", code: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist.", trace: { httpStatus: 404 } };
  }
}

function isResult(value: unknown): value is PayPalResult<never> {
  return !!value && typeof value === "object" && "kind" in value && ["rejected", "unknown", "retryable"].includes((value as { kind: string }).kind);
}
