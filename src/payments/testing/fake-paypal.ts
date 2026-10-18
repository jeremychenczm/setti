/**
 * A fake PayPal for tests. Its answers are shaped from the sandbox calls
 * recorded in probes/recorded, and it honours request ids the way PayPal does:
 * a request id it has already processed gets the original result back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureCommand, CaptureReceipt, PayPalPayments, PayPalResult } from "../paypal";

interface RecordedStep {
  step: string;
  ok: boolean;
  response?: { id: string; status: string };
  error?: { message: string; debug_id?: string; details?: { issue: string }[] };
}

function recorded(file: string, pick: (step: RecordedStep) => boolean): RecordedStep {
  const recording = JSON.parse(readFileSync(join(process.cwd(), "probes", "recorded", file), "utf8")) as { steps: RecordedStep[] };
  const step = recording.steps.find(pick);
  if (!step) throw new Error(`No matching step in ${file}`);
  return step;
}

const recordedCapture = recorded("p2-multiple-partial-captures-vault-g-aged-2026-10-18.json", (s) => s.step.startsWith("capture 1"));
const recordedOverLimit = recorded("p3-over-capture-vault-b-aged-vault-c-aged-2026-10-18.json", (s) => !s.ok);

/**
 * What the next call does:
 * - `succeed`: PayPal captures and answers.
 * - `reject-over-limit`: PayPal refuses with the recorded MAX_CAPTURE_AMOUNT_EXCEEDED error.
 * - `lose-response`: PayPal captures, but the answer never arrives (a timeout).
 * - `time-out`: the call times out before PayPal processes it.
 */
export type FakeBehaviour = "succeed" | "reject-over-limit" | "lose-response" | "time-out";

export class FakePayPal implements PayPalPayments {
  readonly calls: CaptureCommand[] = [];
  private readonly plan: FakeBehaviour[] = [];
  private readonly processed = new Map<string, CaptureReceipt>();
  private nextId = 1;

  /** Queues behaviours for the next calls; once the queue is empty, calls succeed. */
  then(...behaviours: FakeBehaviour[]): this {
    this.plan.push(...behaviours);
    return this;
  }

  async captureAuthorization(command: CaptureCommand): Promise<PayPalResult<CaptureReceipt>> {
    this.calls.push(command);
    const already = this.processed.get(command.requestId);
    const behaviour = this.plan.shift() ?? "succeed";

    if (already && behaviour !== "time-out") return { kind: "ok", value: already };

    switch (behaviour) {
      case "succeed":
        return { kind: "ok", value: this.capture(command) };
      case "lose-response":
        this.capture(command);
        return { kind: "unknown", message: "Timed out waiting for PayPal" };
      case "time-out":
        return { kind: "unknown", message: "Timed out waiting for PayPal" };
      case "reject-over-limit": {
        const error = recordedOverLimit.error!;
        return { kind: "rejected", code: error.details?.[0]?.issue ?? "UNPROCESSABLE_ENTITY", message: error.message, debugId: error.debug_id };
      }
    }
  }

  private capture(command: CaptureCommand): CaptureReceipt {
    const receipt: CaptureReceipt = {
      paypalCaptureId: `${recordedCapture.response!.id}-${this.nextId++}`,
      status: recordedCapture.response!.status === "COMPLETED" ? "completed" : "pending",
      amountCents: command.amountCents,
    };
    this.processed.set(command.requestId, receipt);
    return receipt;
  }
}
