import type { ApprovedQuoteReport, QuoteLineApproval } from "./types";

const approvedAt = "2026-10-03T15:00:00-07:00";

function demoApproval(): QuoteLineApproval {
  return {
    status: "approved",
    approvedBy: "Emma Park",
    approvedAt,
    signature: "Emma Park (demo signature)",
    isDemo: true,
  };
}

/**
 * Fixed Maple V1 example. Names, documents, approval and vendor terms are
 * illustrative, and none of the source references identify a real document.
 * There are deliberately no PayPal IDs or payment-state claims in this quote.
 */
export const mapleApprovedQuote: ApprovedQuoteReport = {
  id: "demo-maple-v1",
  version: 1,
  projectId: "maple",
  projectName: "Maple Ave",
  room: "Window corner",
  clientName: "Emma Park",
  designerName: "Jordan Lee",
  currency: "USD",
  status: "approved",
  approvedAt,
  approvedBy: "Emma Park",
  signature: "Emma Park (demo signature)",
  isDemo: true,
  demoNotice:
    "Sample approved quote. Client, studio, vendors, specifications, source documents, dates and signatures are demonstration data. Vendor terms are illustrative and have not been verified with a supplier.",
  paymentNote:
    "Approved prices only. This report does not confirm a PayPal authorization, charge or refund.",
  assumptions: [
    "All amounts are USD. Tax and freight are shown separately as $0.00 to preserve the $1,500 Maple V1 example; this is a demo assumption, not a claim that real purchases are tax-free or ship for free.",
    "Lead times and return terms are sample inputs for this report, not commitments by a real supplier.",
    "The approval date and typed signature are examples; no actual client approval is represented.",
  ],
  lines: [
    {
      itemId: "design",
      name: "Design services",
      vendor: "Lee Studio (demo)",
      category: "service",
      room: "Window corner",
      sku: "DEMO-DESIGN-01",
      specification: "Initial room layout and furniture selection · fixed service fee",
      quantity: 1,
      unitPriceCents: 40_000,
      taxCents: 0,
      freightCents: 0,
      source: {
        kind: "demo",
        reference: "DEMO-MAPLE-V1-SERVICE",
        name: "Sample design services agreement",
        note: "Illustrative source reference; no real contract or uploaded file.",
      },
      leadTimeDays: null,
      returnPolicy: "Sample service terms: product returns do not apply; any cancellation is reviewed separately.",
      restockingFeeBps: 0,
      customMade: false,
      nonReturnable: false,
      approval: demoApproval(),
    },
    {
      itemId: "chair",
      name: "Lounge chair",
      vendor: "Hart & Co (demo)",
      category: "furniture",
      room: "Window corner",
      sku: "DEMO-CHAIR-01",
      specification: "Upholstered accent chair · natural oak frame · cream fabric",
      quantity: 1,
      unitPriceCents: 80_000,
      taxCents: 0,
      freightCents: 0,
      source: {
        kind: "demo",
        reference: "DEMO-MAPLE-V1-CHAIR",
        name: "Sample lounge chair quote",
        note: "Illustrative price and terms; not a supplier-issued quote.",
      },
      leadTimeDays: 42,
      returnPolicy: "Sample terms: returnable with prior approval; 15% restocking fee after an order is placed.",
      restockingFeeBps: 1_500,
      customMade: false,
      nonReturnable: false,
      approval: demoApproval(),
    },
    {
      itemId: "rug",
      name: "Wool rug",
      vendor: "Loom House (demo)",
      category: "furniture",
      room: "Window corner",
      sku: "DEMO-RUG-01",
      specification: "Wool area rug · 5 × 8 ft · warm ivory",
      quantity: 1,
      unitPriceCents: 30_000,
      taxCents: 0,
      freightCents: 0,
      source: {
        kind: "demo",
        reference: "DEMO-MAPLE-V1-RUG",
        name: "Sample rug quote and return policy",
        note: "Illustrative price and 20% fee; not verified supplier terms.",
      },
      leadTimeDays: 14,
      returnPolicy: "Sample terms: returnable with prior approval; 20% restocking fee after an order is placed.",
      restockingFeeBps: 2_000,
      customMade: false,
      nonReturnable: false,
      approval: demoApproval(),
    },
  ],
};
