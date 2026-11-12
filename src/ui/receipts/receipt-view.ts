/**
 * How a version receipt reads on the page, signed or still a formal quote:
 * labels, the seal, the changes, the payment record grouped like a statement,
 * and the signature certificate. Pure, so the page and its tests describe the
 * same receipt.
 */
import type { LineState } from "@/opening/types";
import { NON_REFUNDABLE_FEE_LABEL } from "@/pricing/fees";
import type { OldItemHandling } from "@/pricing/types";
import type { ChangeReceiptLine, ReceiptPayment, ReceiptPending, VersionReceipt } from "@/receipts/types";
import { units } from "@/ui/pricing/units";

const PT = "America/Los_Angeles";

export const ACTION_LABELS: Record<ReceiptPayment["action"], string> = { held: "Held", charged: "Charged", released: "Released", refunded: "Refunded", renewed: "Hold renewed" };
export const PENDING_LABELS: Record<ReceiptPending["actions"][number]["kind"], string> = { new_authorization: "Hold", release_authorization: "Release hold", capture: "Charge", refund: "Refund" };
export const TIMING_LABELS: Record<ReceiptPending["actions"][number]["timing"], string> = {
  on_payment_execution: "When the payment step runs",
  after_vendor_confirmation: "After the supplier confirms the order",
  after_vendor_credit: "After the supplier's credit arrives",
};
export const VIA_LABELS: Record<NonNullable<ReceiptPayment["confirmed"]>["via"], string> = { webhook: "webhook", readback: "read back", response: "API response" };
export const DECISION_LABELS: Record<LineState, string> = { approved: "Approved", declined: "Declined", withdrawn: "Dropped", pending: "Undecided" };
export const HANDLING_LABELS: Record<OldItemHandling, string> = {
  pending: "Not checked", not_ordered: "Not ordered", cancelled: "Cancelled", modified: "Modified", returned: "Returned", retained: "Kept by the client", not_applicable: "",
};
export const CHANGE_LABELS = { add: "Added", remove: "Removed", replace: "Replaced", quantity: "Quantity changed" } as const;

export function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function signedUsd(cents: number): string {
  return cents === 0 ? usd(0) : `${cents > 0 ? "+" : "−"}${usd(Math.abs(cents))}`;
}

/** "Oct 20, 2026, 11:03 AM PDT"; with seconds for the signature certificate. */
export function ptDateTime(iso: string, seconds = false): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: PT, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), timeZoneName: "short" }).format(new Date(iso));
}

/** "Oct 20" in Pacific time, for statement rows. */
export function ptDay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: PT, month: "short", day: "numeric" }).format(new Date(iso));
}

/** "18:03:12 UTC", printed under a Pacific time so either reader can place it. */
export function utcTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(11, 19)} UTC`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

/** The fingerprint that names the version: of the document when it was sent, else of its agreed lines. */
export function versionFingerprint(receipt: VersionReceipt): string | null {
  return receipt.version.contentHash ?? receipt.version.revision?.contentHash ?? null;
}

/** Whether the client has signed the version: until then the document is its formal quote, not a receipt. */
export function isSigned(receipt: VersionReceipt): boolean {
  return receipt.signatures.length > 0;
}

/** "Signed version receipt", or "Quote version 2" before the client signs. */
export function documentName(receipt: VersionReceipt): string {
  return isSigned(receipt) ? "Signed version receipt" : `Quote version ${receipt.version.number}`;
}

export interface Seal {
  word: string;
  qualifier: string | null;
  ring: string;
  date: string;
  code: string;
  /** "awaiting": sent, not signed yet; "unsigned": replaced before the client signed it. Both are stamped dashed. */
  tone: "ok" | "muted" | "awaiting" | "unsigned";
}

const SEAL_WORDS: Record<VersionReceipt["version"]["status"], [string, string | null]> = {
  approved: ["CONFIRMED", null],
  partly_approved: ["APPROVED", "IN PART"],
  declined: ["DECLINED", null],
  changes_requested: ["RETURNED", "FOR CHANGES"],
  awaiting_signature: ["AWAITING", "SIGNATURE"],
  superseded: ["REPLACED", "NOT SIGNED"],
  draft: ["DRAFT", "NOT SENT"],
};

/** The seal on the title: what the client did, on which day, and the version's fingerprint; before a signature, the day it was sent. */
export function sealOf(receipt: VersionReceipt): Seal {
  const { version, signatures, project } = receipt;
  const signed = isSigned(receipt);
  const at = signed ? signatures.reduce((latest, signature) => signature.at > latest ? signature.at : latest, signatures[0].at) : version.sentAt ?? receipt.issuedAt;
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: PT, day: "numeric", month: "short", year: "numeric" }).format(new Date(at)).toUpperCase();
  const sample = signed && signatures.every((signature) => signature.method === "sample");
  const [word, qualifier] = version.status === "approved" && version.number === 1 ? ["APPROVED", null] : SEAL_WORDS[version.status];
  const name = `${project.name.toUpperCase()} · V${version.number} ·`;
  return {
    word, qualifier, date: signed || version.status === "draft" ? day : `SENT ${day}`,
    ring: sample ? "SETTI · DEMO SAMPLE APPROVAL · NOT SIGNED IN SETTI ·" : signed ? `SETTI · SIGNED VERSION RECEIPT · ${name}`
      : `SETTI · QUOTE ${version.status === "awaiting_signature" ? "AWAITING SIGNATURE" : version.status === "draft" ? "DRAFT · NOT SENT" : "NOT SIGNED"} · ${name}`,
    code: versionFingerprint(receipt)?.slice(0, 8).toUpperCase() ?? (version.status === "draft" ? "PREVIEW" : "SAMPLE"),
    tone: version.status === "approved" || version.status === "partly_approved" ? "ok" : version.status === "awaiting_signature" ? "awaiting" : version.status === "superseded" || version.status === "draft" ? "unsigned" : "muted",
  };
}

export interface ChangeRow {
  change: ChangeReceiptLine;
  /** The item in the earlier version and in this one; this version's amount includes the fees the old item keeps. Null where the version has no such item. */
  beforeCents: number | null;
  afterCents: number | null;
  changeCents: number;
  /** "8 → 14", "22 → 18 linear ft, $280 fabrication fee", "New · 12". */
  summary: string;
}

/** "$280", "$19.50": an amount inside a short phrase. */
function phraseUsd(cents: number): string {
  const digits = cents % 100 ? 2 : 0;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
}

function changeSummary({ action, before, after, oldItem }: ChangeReceiptLine): string {
  const what = action === "add" && after ? `New · ${units(after.quantity, after.unitLabel)}`
    : action === "quantity" && before && after ? `${before.quantity} → ${units(after.quantity, after.unitLabel)}`
      : action === "replace" && before ? `Replaces ${before.name}` : "Removed";
  if (!oldItem || oldItem.retainedCents <= 0) return what;
  const kept = oldItem.fees.length ? oldItem.fees.map((fee) => `${phraseUsd(fee.amountCents)} ${NON_REFUNDABLE_FEE_LABEL[fee.kind].toLowerCase()}`).join(", ") : `${phraseUsd(oldItem.retainedCents)} not refunded`;
  return `${what}, ${kept}`;
}

/**
 * Each change with its amounts as the receipt states them: an old item's
 * non-refundable fees are part of this version's amount for the line, so the
 * changes add up to the version's difference.
 */
export function changeRows(changes: readonly ChangeReceiptLine[]): ChangeRow[] {
  return changes.map((change) => {
    const retained = change.oldItem?.retainedCents ?? 0;
    const beforeCents = change.before ? change.before.totalCents : null;
    const afterCents = change.after || retained ? (change.after?.totalCents ?? 0) + retained : null;
    return { change, beforeCents, afterCents, changeCents: (afterCents ?? 0) - (beforeCents ?? 0), summary: changeSummary(change) };
  });
}

/** The payment record as a statement: steps brought forward from each earlier version, then this version's own. */
export function paymentGroups(receipt: VersionReceipt): { title: string; rows: ReceiptPayment[] }[] {
  const earlier = [...new Set(receipt.payments.filter((step) => step.broughtForward).map((step) => step.version!))].sort((a, b) => a - b);
  return [
    ...earlier.map((version) => ({ title: `Brought forward from version ${version}`, rows: receipt.payments.filter((step) => step.broughtForward && step.version === version) })),
    { title: `Under version ${receipt.version.number}`, rows: receipt.payments.filter((step) => !step.broughtForward) },
  ].filter((group) => group.rows.length);
}

export interface PendingRow {
  label: string;
  /** The items a combined row covers. */
  items: string | null;
  kind: ReceiptPending["actions"][number]["kind"];
  timing: ReceiptPending["actions"][number]["timing"];
  amountCents: number;
}

/**
 * What remained to happen, one row per step; more than three steps of the same
 * kind and timing (a V1 nobody has paid for yet) read as one row with their total.
 */
export function pendingRows(pending: ReceiptPending): PendingRow[] {
  const groups = new Map<string, ReceiptPending["actions"]>();
  for (const action of pending.actions) {
    const key = `${action.kind}:${action.timing}`;
    groups.set(key, [...(groups.get(key) ?? []), action]);
  }
  return [...groups.values()].flatMap((actions): PendingRow[] => actions.length > 3
    ? [{ label: `${actions.length} items`, items: actions.map((action) => action.label).join(", "), kind: actions[0].kind, timing: actions[0].timing, amountCents: actions.reduce((sum, action) => sum + action.amountCents, 0) }]
    : actions.map((action) => ({ label: action.label, items: null, kind: action.kind, timing: action.timing, amountCents: action.amountCents })));
}

/** The PayPal ids of a step, as printed. */
export function paypalReference(step: ReceiptPayment): string {
  const { authorizationId, captureId, refundId } = step.paypal;
  if (captureId) return `Capture ${captureId}`;
  if (refundId) return `Refund ${refundId}`;
  if (authorizationId) return step.action === "released" ? `Void of ${authorizationId}` : `Authorization ${authorizationId}`;
  return "—";
}

export interface CertificateRow {
  event: string;
  by: string;
  role: string;
  at: string | null;
  fingerprint: string | null;
  matches: boolean | null;
}

/** Who sent the version and who signed it, each with the fingerprint recorded at that moment; before a signature, the client's empty row. */
export function certificateRows(receipt: VersionReceipt): CertificateRow[] {
  const { version, signatures, project } = receipt;
  const sent: CertificateRow[] = version.sentAt ? [{ event: `Version ${version.number} sent`, by: version.sentBy ?? project.designer, role: "Designer", at: version.sentAt, fingerprint: version.contentHash, matches: null }] : [];
  if (!signatures.length) return [...sent, { event: version.status === "superseded" ? "Not signed · replaced" : version.status === "draft" ? "Not sent yet" : "Awaiting signature", by: project.client, role: "Client", at: null, fingerprint: null, matches: null }];
  return [...sent, ...signatures.map((signature, index): CertificateRow => ({
    event: signature.method === "sample" ? "Sample approval (demo)"
      : version.number === 1 ? `Signing ${index + 1}`
        : signature.decision === "changes_requested" ? "Changes requested" : `Version ${version.number} confirmed`,
    by: signature.name, role: "Client", at: signature.at,
    fingerprint: signature.contentHash ?? signature.revisionContentHash, matches: signature.matches,
  }))];
}

/** The command a reader runs on the downloaded record to recompute the version's fingerprint. */
export function verifyCommand(receiptNo: string): string {
  return `node -e "const r=require('./${receiptNo}.json');const c=v=>Array.isArray(v)?'['+v.map(c)+']':v&&typeof v=='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+c(v[k]))+'}':JSON.stringify(v);console.log(require('crypto').createHash('sha256').update(c(r.version.document)).digest('hex'))"`;
}
