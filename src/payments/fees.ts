/**
 * Seller breakdowns are evidence, not pricing rules. Only a complete, consistent
 * USD breakdown can contribute to the displayed merchant receipt/debit. The
 * original provider fields remain in the append-only call details even when
 * this narrow view cannot use them. No rate, missing fee or net is inferred.
 */
import type { CaptureReceipt, RefundReceipt } from "./paypal";

export interface SettlementView {
  state: "reported" | "missing" | "invalid" | "unsupported";
  grossCents: number | null;
  feeCents: number | null;
  netCents: number | null;
  reason: string | null;
}

type Details = Record<string, string | number | boolean | null>;

/** A small allowlist; never stores payer details, arbitrary SDK JSON or URLs. */
export function settlementDetails(receipt: CaptureReceipt | RefundReceipt): Details {
  const settlement = receipt.settlement;
  if (!settlement) return {};
  return {
    settlementPresent: true,
    settlementVersion: 1,
    settlementGrossCents: settlement.gross.amountCents ?? null,
    settlementGrossCurrency: settlement.gross.currency ?? null,
    settlementFeeCents: settlement.fee.amountCents ?? null,
    settlementFeeCurrency: settlement.fee.currency ?? null,
    settlementNetCents: settlement.net.amountCents ?? null,
    settlementNetCurrency: settlement.net.currency ?? null,
    settlementPlatformFeesPresent: settlement.platformFeesPresent,
    settlementConversionPresent: settlement.conversionPresent,
    settlementMalformed: settlement.malformed ?? false,
  };
}

const validCents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const absent = (value: unknown) => value === undefined || value === null;
const unknown = (state: Exclude<SettlementView["state"], "reported">, reason: string): SettlementView => ({ state, grossCents: null, feeCents: null, netCents: null, reason });

/**
 * For refunds, fee is the provider's seller_payable_breakdown fee component and
 * net is the merchant debit. It is not a newly charged "refund processing fee".
 * PayPal's simple USD examples use gross - fee = net for captures and refunds.
 * Platform fees and currency conversion need a different model, so stay unknown.
 */
export function readSettlement(kind: "capture" | "refund", amountCents: number, currency: string, details: Details): SettlementView {
  if (details.settlementPresent !== true) return unknown("missing", "PayPal seller breakdown has not been recorded.");
  if (details.settlementVersion !== 1 || !["capture", "refund"].includes(kind)) return unknown("invalid", "The recorded seller breakdown format is not recognised.");
  if (!validCents(amountCents)) return unknown("invalid", "The transaction amount is not a valid cent amount.");
  if (details.settlementMalformed === true) return unknown("invalid", "A provider-reported seller amount could not be read exactly.");
  for (const flag of [details.settlementPlatformFeesPresent, details.settlementConversionPresent, details.settlementMalformed]) {
    if (!absent(flag) && typeof flag !== "boolean") return unknown("invalid", "The seller breakdown flags are invalid.");
  }
  if (details.settlementPlatformFeesPresent === true || details.settlementConversionPresent === true) {
    return unknown("unsupported", "Platform fees or currency conversion require separate reconciliation.");
  }
  const currencies = [currency, details.settlementGrossCurrency, details.settlementFeeCurrency, details.settlementNetCurrency];
  if (currencies.some((value) => !absent(value) && typeof value !== "string")) return unknown("invalid", "A seller amount has an invalid currency.");
  if (currencies.some((value) => typeof value === "string" && value !== "USD")) return unknown("unsupported", "Only same-currency USD seller breakdowns are shown.");
  const gross = details.settlementGrossCents, fee = details.settlementFeeCents, net = details.settlementNetCents;
  const amounts = [gross, fee, net];
  if (amounts.some((value) => !absent(value) && !validCents(value))) return unknown("invalid", "A seller amount is not a valid cent amount.");
  if (currencies.some(absent) || amounts.some(absent)) return unknown("missing", "The recorded seller breakdown is incomplete; missing amounts are not zero.");
  if (!validCents(gross) || !validCents(fee) || !validCents(net) || gross !== amountCents || fee > gross || gross - fee !== net) {
    return unknown("invalid", "The seller breakdown does not reconcile to this transaction.");
  }
  return { state: "reported", grossCents: gross, feeCents: fee, netCents: net, reason: null };
}
