/**
 * Sandbox proof evidence: reads every PayPal resource of a proof run back with
 * GET, compares it with the local ledger and writes a dated evidence folder.
 * Only identifiers, statuses, amounts, debug ids and seller breakdowns are kept;
 * no payer details and no approval links.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { readLedger } from "../approval/store";
import type { Db } from "../db/client";
import type { PayPalPayments, PayPalResult, ReportedSettlement } from "../payments/paypal";
import { paypalCalls } from "../payments/schema";
import { paymentsWorkspace } from "../payments/workspace";
import type { ProofRun } from "./scenario";

export interface ProviderObservation {
  kind: "order" | "authorization" | "capture" | "refund";
  id: string;
  outcome: PayPalResult<unknown>["kind"];
  status: string | null;
  amountCents: number | null;
  currency: string | null;
  httpStatus: number | null;
  debugId: string | null;
  customId?: string | null;
  /** Refunds PayPal lists on an order. */
  refunds?: { id: string; customId: string | null }[];
  settlement?: { grossCents: number | null; feeCents: number | null; netCents: number | null; currency: string | null } | null;
}

export interface EvidenceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SourceFingerprint {
  commit: string | null;
  /** Whether src/ had uncommitted changes when the proof ran. */
  dirty: boolean | null;
  files: { path: string; sha256: string }[];
}

export interface ItemOutcome {
  label: string;
  side: "baseline" | "proposed";
  targetCents: number;
  heldCents: number;
  capturedCents: number;
  refundedCents: number;
  releasedCents: number;
}

export interface Evidence {
  scenario: "mixed-change";
  generatedAt: string;
  environment: "sandbox";
  source: SourceFingerprint;
  changeOrders: { label: string; id: string; version: number; contentHash: string }[];
  steps: ProofRun["steps"];
  provider: ProviderObservation[];
  ledger: unknown;
  items: ItemOutcome[];
  checks: EvidenceCheck[];
  passed: boolean;
}

const authorizationStatus: Record<string, string> = { created: "CREATED", partially_captured: "PARTIALLY_CAPTURED", captured: "CAPTURED", voided: "VOIDED", expired: "EXPIRED" };
const captureStatus: Record<string, string[]> = { completed: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"], pending: ["PENDING"], declined: ["DECLINED"] };
const refundStatus: Record<string, string[]> = { completed: ["COMPLETED"], pending: ["PENDING"], failed: ["FAILED", "CANCELLED"] };

/** What the mixed change must leave behind for each item, from the confirmed version. */
const expectedItems: { key: string; label: string; fields: Partial<ItemOutcome> }[] = [
  { key: "chair:baseline", label: "Lounge chair hold released, nothing charged", fields: { heldCents: 0, capturedCents: 0, refundedCents: 0, releasedCents: 80_000 } },
  { key: "chair:proposed", label: "Writing desk captured in full", fields: { heldCents: 0, capturedCents: 110_000, refundedCents: 0 } },
  { key: "rug:baseline", label: "Rug refunded except the $60 restocking fee", fields: { heldCents: 0, capturedCents: 30_000, refundedCents: 24_000, targetCents: 6_000 } },
];

function observe(kind: ProviderObservation["kind"], id: string, result: PayPalResult<{ status?: string; amountCents?: number; currency?: string; customId?: string; settlement?: ReportedSettlement }>): ProviderObservation {
  const value = result.kind === "ok" ? result.value : undefined;
  const settlement = value?.settlement;
  return {
    kind, id, outcome: result.kind,
    status: value?.status ?? null, amountCents: value?.amountCents ?? null, currency: value?.currency ?? null,
    httpStatus: result.trace?.httpStatus ?? null, debugId: result.trace?.debugId ?? null,
    ...(kind === "refund" ? { customId: value?.customId ?? null } : {}),
    ...(kind === "capture" || kind === "refund" ? { settlement: settlement ? { grossCents: settlement.gross.amountCents ?? null, feeCents: settlement.fee.amountCents ?? null, netCents: settlement.net.amountCents ?? null, currency: settlement.net.currency ?? null } : null } : {}),
  };
}

export async function collectEvidence(db: Db, paypal: PayPalPayments, run: ProofRun, source: SourceFingerprint, now = new Date()): Promise<Evidence> {
  const ledger = await readLedger(db, run.projectId);
  const provider: ProviderObservation[] = [];
  const checks: EvidenceCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  for (const hold of ledger.authorizations) {
    const seen = observe("authorization", hold.paypalAuthorizationId, await paypal.getAuthorization(hold.paypalAuthorizationId));
    provider.push(seen);
    check(`Authorization ${hold.paypalAuthorizationId} matches the ledger`, seen.outcome === "ok" && seen.amountCents === hold.amountCents && seen.status === authorizationStatus[hold.status],
      `PayPal ${seen.status ?? seen.outcome} ${seen.amountCents ?? "?"}¢; ledger ${hold.status} ${hold.amountCents}¢`);
  }
  for (const capture of ledger.captures) {
    const seen = observe("capture", capture.paypalCaptureId, await paypal.getCapture(capture.paypalCaptureId));
    provider.push(seen);
    check(`Capture ${capture.paypalCaptureId} matches the ledger`, seen.outcome === "ok" && seen.amountCents === capture.amountCents && (captureStatus[capture.status] ?? []).includes(seen.status ?? ""),
      `PayPal ${seen.status ?? seen.outcome} ${seen.amountCents ?? "?"}¢; ledger ${capture.status} ${capture.amountCents}¢`);
  }
  for (const refund of ledger.refunds) {
    const seen = observe("refund", refund.paypalRefundId, await paypal.getRefund(refund.paypalRefundId));
    provider.push(seen);
    check(`Refund ${refund.paypalRefundId} matches the ledger`, seen.outcome === "ok" && seen.amountCents === refund.amountCents && (refundStatus[refund.status] ?? []).includes(seen.status ?? "") && seen.customId === refund.operationId,
      `PayPal ${seen.status ?? seen.outcome} ${seen.amountCents ?? "?"}¢ custom_id ${seen.customId ?? "none"}; ledger ${refund.status} ${refund.amountCents}¢ operation ${refund.operationId}`);
  }

  // Every refund PayPal lists on an order must be one the ledger knows about.
  const paypalRefunds: { id: string; customId: string | null }[] = [];
  for (const orderId of [...new Set(ledger.authorizations.map((hold) => hold.paypalOrderId))]) {
    const result = await paypal.getOrder(orderId);
    const refunds = result.kind === "ok" ? (result.value.refunds ?? []).map((refund) => ({ id: refund.paypalRefundId ?? "", customId: refund.customId ?? null })) : [];
    provider.push({ ...observe("order", orderId, result), refunds });
    paypalRefunds.push(...refunds);
    const holds = new Set(ledger.authorizations.filter((hold) => hold.paypalOrderId === orderId).map((hold) => hold.id));
    const captures = new Set(ledger.captures.filter((capture) => capture.authorizationId && holds.has(capture.authorizationId)).map((capture) => capture.id));
    const local = ledger.refunds.filter((refund) => captures.has(refund.captureId)).map((refund) => refund.paypalRefundId).sort();
    const listed = refunds.map((refund) => refund.id).sort();
    check(`Order ${orderId} lists exactly the recorded refunds`, result.kind === "ok" && JSON.stringify(local) === JSON.stringify(listed), `PayPal [${listed.join(", ")}]; ledger [${local.join(", ")}]`);
  }
  for (const operation of ledger.operations.filter((entry) => entry.kind === "refund")) {
    const count = paypalRefunds.filter((refund) => refund.customId === operation.id).length;
    check(`Refund step ${operation.id} produced exactly one PayPal refund`, count === 1, `${count} PayPal refund(s) carry this step's custom_id`);
  }
  if (run.droppedRefundOperationId) {
    const operation = ledger.operations.find((entry) => entry.id === run.droppedRefundOperationId);
    const lookups = await db.select().from(paypalCalls).where(and(eq(paypalCalls.operationId, run.droppedRefundOperationId), eq(paypalCalls.step, "get_order")));
    const found = lookups.some((call) => call.outcome === "ok" && call.details.refundLookup === true && call.details.matchingRefunds === 1);
    check("A refund whose answer was lost is recovered without a second refund", !!operation && operation.status === "succeeded" && operation.attempts >= 2 && found,
      `operation ${operation?.status ?? "missing"} after ${operation?.attempts ?? 0} attempt(s); order lookup ${found ? "found the refund by custom_id" : "did not find it"}`);
  }

  const lines = (await paymentsWorkspace(db, run.session, run.mixed.id))?.lines ?? [];
  const items: ItemOutcome[] = lines.map((line) => ({ label: line.label, side: line.side, targetCents: line.targetCents, heldCents: line.heldCents, capturedCents: line.capturedCents, refundedCents: line.refundedCents, releasedCents: line.releasedCents }));
  for (const expected of expectedItems) {
    const line = lines.find((entry) => `${entry.itemId}:${entry.side}` === expected.key);
    const mismatched = line ? Object.entries(expected.fields).filter(([field, value]) => line[field as keyof ItemOutcome] !== value) : [];
    check(expected.label, !!line && mismatched.length === 0, line ? mismatched.map(([field, value]) => `${field} ${line[field as keyof ItemOutcome]} ≠ ${value}`).join("; ") || "as confirmed" : "line missing");
  }

  return {
    scenario: "mixed-change", generatedAt: now.toISOString(), environment: "sandbox", source,
    changeOrders: [{ label: "First confirmed version", order: run.initial }, { label: "Mixed change", order: run.mixed }].map(({ label, order }) => ({ label, id: order.id, version: order.version, contentHash: order.contentHash })),
    steps: run.steps, provider,
    ledger: {
      authorizations: ledger.authorizations, captures: ledger.captures, refunds: ledger.refunds, supplierEvents: ledger.supplierEvents,
      operations: ledger.operations.map(withoutApprovalLink),
    },
    items, checks, passed: checks.length > 0 && checks.every((entry) => entry.ok),
  };
}

/** Approval links carry checkout tokens and are of no use as evidence. */
function withoutApprovalLink<T extends { approvalUrl: string | null }>(operation: T): Omit<T, "approvalUrl"> {
  const copy: Partial<T> = { ...operation };
  delete copy.approvalUrl;
  return copy as Omit<T, "approvalUrl">;
}

/** The commit and the payment source files the proof ran on. */
export async function sourceFingerprint(root: string): Promise<SourceFingerprint> {
  const git = (args: string[]) => {
    try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); } catch { return null; }
  };
  const status = git(["status", "--porcelain", "--", "src"]);
  const directory = path.join(root, "src", "payments");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort();
  const files = await Promise.all(names.map(async (name) => ({ path: `src/payments/${name}`, sha256: createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex") })));
  return { commit: git(["rev-parse", "HEAD"]), dirty: status === null ? null : status.length > 0, files };
}

const dollars = (cents: number | null) => cents === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export function evidenceReadme(evidence: Evidence): string {
  const failed = evidence.checks.filter((entry) => !entry.ok);
  const commit = evidence.source.commit ? `\`${evidence.source.commit.slice(0, 7)}\`${evidence.source.dirty ? " with uncommitted changes in src/" : ""}` : "an unknown commit";
  const fees = evidence.provider.filter((entry) => entry.kind === "capture" || entry.kind === "refund");
  return [
    "# Sandbox proof: one change, three money actions",
    "",
    `Generated ${evidence.generatedAt} from ${commit} against the PayPal Sandbox (test money).`,
    "",
    failed.length ? `**Result: ${failed.length} of ${evidence.checks.length} checks failed.**` : `**Result: all ${evidence.checks.length} checks passed.**`,
    "",
    "One client-confirmed change replaces a held lounge chair with a writing desk and returns a captured rug with a $60 restocking fee. Setti releases the chair's hold, authorizes and captures the desk, and refunds the rug minus the fee, each as its own PayPal action.",
    "",
    "## Steps",
    "",
    "| Step | PayPal operations |",
    "|---|---|",
    ...evidence.steps.map((step) => `| ${step.label} | ${step.operations.map((operation) => `${operation.kind} ${dollars(operation.amountCents)} · ${operation.status}${operation.paypalResourceId ? ` · \`${operation.paypalResourceId}\`` : ""}`).join("<br>")} |`),
    "",
    "## Checks",
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...evidence.checks.map((entry) => `| ${entry.name} | ${entry.ok ? "pass" : "**fail**"} | ${entry.detail} |`),
    "",
    "## PayPal resources read back with GET",
    "",
    "| Kind | PayPal ID | Status | Amount | Debug ID |",
    "|---|---|---|---|---|",
    ...evidence.provider.map((entry) => `| ${entry.kind} | \`${entry.id}\` | ${entry.status ?? entry.outcome} | ${dollars(entry.amountCents)} | ${entry.debugId ? `\`${entry.debugId}\`` : "—"} |`),
    "",
    "## Seller breakdown reported by PayPal",
    "",
    "| Kind | PayPal ID | Gross | PayPal fee | Net |",
    "|---|---|---|---|---|",
    ...fees.map((entry) => entry.settlement ? `| ${entry.kind} | \`${entry.id}\` | ${dollars(entry.settlement.grossCents)} | ${dollars(entry.settlement.feeCents)} | ${dollars(entry.settlement.netCents)} |` : `| ${entry.kind} | \`${entry.id}\` | — | not reported | — |`),
    "",
    "## How this was produced",
    "",
    "- `npm run sandbox:proof` ran the app's own chat, pricing, approval and payment code against an isolated proof database and the PayPal Sandbox.",
    "- The sandbox buyer approved each authorization on PayPal's checkout page. The AI draft step used a fixed draft; supplier confirmations and credits are designer-entered demo records.",
    "- `provider-verification.json` holds every GET result and check; `ledger.json` holds the local money records and steps. Payment source files are fingerprinted by SHA-256.",
    "",
  ].join("\n");
}

export async function writeEvidence(directory: string, evidence: Evidence): Promise<void> {
  await mkdir(directory, { recursive: true });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path.join(directory, "provider-verification.json"), json({ generatedAt: evidence.generatedAt, environment: evidence.environment, source: evidence.source, provider: evidence.provider, checks: evidence.checks, passed: evidence.passed }));
  await writeFile(path.join(directory, "ledger.json"), json({ changeOrders: evidence.changeOrders, steps: evidence.steps, items: evidence.items, ledger: evidence.ledger }));
  await writeFile(path.join(directory, "README.md"), evidenceReadme(evidence));
}
