/**
 * A fake PayPal for tests. Its answers are shaped from the sandbox calls
 * recorded in probes/recorded, and it honours request ids the way PayPal does:
 * a request id it has already processed gets the original result back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureCommand, CaptureReceipt, PayPalPayments, PayPalResult, VoidCommand, VoidReceipt } from "../paypal";

interface RecordedStep {
  step: string;
  ok: boolean;
  response?: { id: string; status: string; amount?: { value: string } };
  error?: { message: string; debug_id?: string; details?: { issue: string }[] };
}

function recorded(file: string, pick: (step: RecordedStep) => boolean): RecordedStep {
  const recording = JSON.parse(readFileSync(join(process.cwd(), "probes", "recorded", file), "utf8")) as { steps: RecordedStep[] };
  const step = recording.steps.find(pick);
  if (!step) throw new Error(`No matching step in ${file}`);
  return step;
}

const recordedCapture = recorded("p2-multiple-partial-captures-vault-g-aged-2026-10-18.json", (s) => s.step.startsWith("capture 1"));
const recordedAlreadyCaptured = recorded("p2-multiple-partial-captures-vault-g-aged-2026-10-18.json", (s) => !s.ok);
const recordedOverLimit = recorded("p3-over-capture-vault-b-aged-vault-c-aged-2026-10-18.json", (s) => !s.ok);
const recordedVoid = recorded("p9-void-after-partial-vault-d-aged-2026-10-18.json", (s) => s.step.startsWith("void"));

/**
 * What the next call does:
 * - `succeed`: PayPal does it and answers.
 * - `reject-over-limit`: refused with the recorded MAX_CAPTURE_AMOUNT_EXCEEDED error.
 * - `reject-already-captured`: refused with the recorded AUTHORIZATION_ALREADY_CAPTURED error.
 * - `lose-response`: PayPal does it, but the answer never arrives (a timeout).
 * - `time-out`: the call times out before PayPal processes it.
 */
export type FakeBehaviour = "succeed" | "reject-over-limit" | "reject-already-captured" | "lose-response" | "time-out";

const TIMEOUT = { kind: "unknown", message: "Timed out waiting for PayPal" } as const;

function rejection(step: RecordedStep, fallback: string): PayPalResult<never> {
  const error = step.error!;
  return { kind: "rejected", code: error.details?.[0]?.issue ?? fallback, message: error.message, debugId: error.debug_id };
}

export class FakePayPal implements PayPalPayments {
  readonly calls: (CaptureCommand | VoidCommand)[] = [];
  private readonly plan: FakeBehaviour[] = [];
  private readonly captures = new Map<string, CaptureReceipt>();
  private readonly voids = new Map<string, VoidReceipt>();
  private nextId = 1;

  /** Queues behaviours for the next calls; once the queue is empty, calls succeed. */
  then(...behaviours: FakeBehaviour[]): this {
    this.plan.push(...behaviours);
    return this;
  }

  async captureAuthorization(command: CaptureCommand): Promise<PayPalResult<CaptureReceipt>> {
    this.calls.push(command);
    const already = this.captures.get(command.requestId);
    const behaviour = this.plan.shift() ?? "succeed";
    if (already && behaviour !== "time-out") return { kind: "ok", value: already };

    switch (behaviour) {
      case "succeed":
        return { kind: "ok", value: this.capture(command) };
      case "lose-response":
        this.capture(command);
        return TIMEOUT;
      case "time-out":
        return TIMEOUT;
      case "reject-over-limit":
        return rejection(recordedOverLimit, "UNPROCESSABLE_ENTITY");
      case "reject-already-captured":
        return rejection(recordedAlreadyCaptured, "UNPROCESSABLE_ENTITY");
    }
  }

  async voidAuthorization(command: VoidCommand): Promise<PayPalResult<VoidReceipt>> {
    this.calls.push(command);
    const already = this.voids.get(command.requestId);
    const behaviour = this.plan.shift() ?? "succeed";
    if (already && behaviour !== "time-out") return { kind: "ok", value: already };

    switch (behaviour) {
      case "succeed":
        return { kind: "ok", value: this.void(command) };
      case "lose-response":
        this.void(command);
        return TIMEOUT;
      case "time-out":
        return TIMEOUT;
      case "reject-over-limit":
        return rejection(recordedOverLimit, "UNPROCESSABLE_ENTITY");
      case "reject-already-captured":
        // Recorded on a capture after the final one; PayPal refuses a void of a fully captured hold the same way.
        return rejection(recordedAlreadyCaptured, "UNPROCESSABLE_ENTITY");
    }
  }

  private capture(command: CaptureCommand): CaptureReceipt {
    const receipt: CaptureReceipt = {
      paypalCaptureId: `${recordedCapture.response!.id}-${this.nextId++}`,
      status: recordedCapture.response!.status === "COMPLETED" ? "completed" : "pending",
      amountCents: command.amountCents,
    };
    this.captures.set(command.requestId, receipt);
    return receipt;
  }

  private void(command: VoidCommand): VoidReceipt {
    const value = recordedVoid.response?.amount?.value;
    const receipt: VoidReceipt = { reportedAmountCents: value === undefined ? undefined : Math.round(Number(value) * 100) };
    this.voids.set(command.requestId, receipt);
    return receipt;
  }
}
