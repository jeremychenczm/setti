/**
 * Records what PayPal actually did. Each probe collects steps (request summary,
 * response or error, timing) and writes them to probes/recorded/<probe>-<date>.json
 * with personal data removed. These recordings become the templates for the
 * fake PayPal used in tests later.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "@paypal/paypal-server-sdk";

const REDACT_KEYS = new Set([
  "name",
  "givenName",
  "surname",
  "fullName",
  "emailAddress",
  "email_address",
  "payerId",
  "payer_id",
  "accountId",
  "account_id",
  "phone",
  "phoneNumber",
  "address",
  "birthDate",
  "taxInfo",
]);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

export interface StepRecord {
  step: string;
  request: unknown;
  ok: boolean;
  statusCode?: number;
  debugId?: string;
  response?: unknown;
  error?: unknown;
  startedAt: string;
  durationMs: number;
}

export class Recorder {
  readonly steps: StepRecord[] = [];
  readonly notes: string[] = [];

  constructor(readonly probe: string) {}

  note(text: string): void {
    this.notes.push(text);
    console.log(`  note: ${text}`);
  }

  /**
   * Runs one PayPal call. Errors are recorded, not thrown, because several
   * probes exist precisely to capture PayPal's error responses.
   */
  async step<T>(
    step: string,
    request: unknown,
    call: () => Promise<{ statusCode: number; headers: Record<string, string>; result: T }>,
  ): Promise<T | undefined> {
    const startedAt = new Date();
    const record: StepRecord = {
      step,
      request: redact(request),
      ok: false,
      startedAt: startedAt.toISOString(),
      durationMs: 0,
    };
    try {
      const res = await call();
      record.ok = true;
      record.statusCode = res.statusCode;
      record.debugId = res.headers["paypal-debug-id"];
      record.response = redact(res.result);
      console.log(`  ok    ${step} (${res.statusCode})`);
      return res.result;
    } catch (err) {
      if (err instanceof ApiError) {
        record.statusCode = err.statusCode;
        record.debugId = err.headers?.["paypal-debug-id"];
        record.error = redact(err.result ?? String(err.body));
      } else {
        record.error = err instanceof Error ? err.message : String(err);
      }
      console.log(`  error ${step} (${record.statusCode ?? "no status"})`);
      return undefined;
    } finally {
      record.durationMs = Date.now() - startedAt.getTime();
      this.steps.push(record);
    }
  }

  save(): string {
    const dir = join("probes", "recorded");
    mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = join(dir, `${this.probe}-${date}.json`);
    const body = {
      probe: this.probe,
      recordedAt: new Date().toISOString(),
      environment: "sandbox",
      notes: this.notes,
      steps: this.steps,
    };
    writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
    console.log(`\nRecorded ${this.steps.length} step(s) to ${file}. Review it before committing.`);
    return file;
  }
}
