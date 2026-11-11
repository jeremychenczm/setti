/**
 * Test fixture: a small project whose V1 starts as a draft the designer sends
 * from the chat and the client signs line by line. Tests add it to their
 * studio with `addTestProject`; product code never imports this file.
 *
 * Every amount is written out, so expected totals can be worked out by hand:
 *
 *   line                     qty × unit        tax (8%)   freight     total
 *   Three-seat sofa            1 × $800.00       $64.00   $100.00   $964.00
 *   Dining chair               4 × $80.00        $25.60         —   $345.60
 *   Writing desk               1 × $250.00       $20.00         —   $270.00
 *   Porcelain floor tile       5 × $45.00 /box   $18.00         —   $243.00
 *   Design consultation        2 × $150.00 /hr        —         —   $300.00
 *   Space planning             4 × $125.00 /hr        —         —   $500.00
 *
 *   furniture $1,822.60 · services $800.00 · V1 $2,622.60
 */
import type { DemoAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import type { Db } from "@/db/client";
import { approvedForTest } from "@/opening/testing";
import type { ApprovedQuoteReport, QuoteDocument, QuoteLine } from "@/quotes/types";
import { insertProject, type NewProject } from "./store";

export const TEST_KEY: CaseKey = "fernhill";

export const SOFA = "fernhill-sofa", CHAIR = "fernhill-chair", DESK = "fernhill-desk", TILE = "fernhill-tile";
export const CONSULTATION = "fernhill-consultation", PLANNING = "fernhill-planning";

export const SOFA_CENTS = 96_400, CHAIR_CENTS = 34_560, DESK_CENTS = 27_000, TILE_CENTS = 24_300;
export const CONSULTATION_CENTS = 30_000, PLANNING_CENTS = 50_000;
export const FURNITURE_CENTS = 182_260, SERVICES_CENTS = 80_000, V1_CENTS = 262_260;

export const testDesigner: DemoAccount = { id: "test-designer", name: "Jordan Lee", role: "designer", title: "Designer", projectKey: null };
export const testClient: DemoAccount = { id: "test-client", name: "Ava Chen", role: "client", title: "Client · Fernhill Apartment", projectKey: TEST_KEY };

const NORTHWOOD = "Northwood Furniture", BRIGHTDESK = "Brightdesk Office", STONEWARE = "Stoneware Tile Co";

function furniture(line: Pick<QuoteLine, "itemId" | "name" | "vendor" | "room" | "sku" | "quantity" | "unitPriceCents" | "taxCents"> & Partial<QuoteLine>): QuoteLine {
  return {
    category: "furniture", specification: `${line.name} (test product)`, unitLabel: "each", freightCents: 0,
    source: { kind: "public_reference", reference: `fernhill:${line.itemId}`, name: line.vendor, note: "Test price.", url: `https://supplier.example.com/${line.sku}` },
    leadTimeDays: 14, returnPolicy: `${line.vendor} test terms: unused items may be returned within 30 days.`, restockingFeeBps: null,
    customMade: false, nonReturnable: null, ...line,
  };
}

function service(line: Pick<QuoteLine, "itemId" | "name" | "sku" | "quantity" | "unitPriceCents">): QuoteLine {
  return {
    category: "service", vendor: "Lee Studio", room: "Whole apartment", specification: `${line.name} (test estimate)`, unitLabel: "hour",
    taxCents: 0, freightCents: 0, source: { kind: "estimate", reference: `fernhill:${line.itemId}`, name: "Lee Studio", note: "Test estimate." },
    leadTimeDays: null, returnPolicy: "Test terms: services not yet performed can be cancelled.", restockingFeeBps: null,
    customMade: false, nonReturnable: null, ...line,
  };
}

/** The draft V1, as the designer prepared it before sending. */
export const testQuote: QuoteDocument = {
  id: "fernhill-v1", version: 1, projectId: TEST_KEY, projectName: "Fernhill Apartment", room: "Living room · Dining room · Study · Entry",
  clientName: "Ava Chen", designerName: "Jordan Lee", currency: "USD", isDemo: true,
  demoNotice: "Test quote.", paymentNote: "This quote confirms no payment.", assumptions: ["Merchandise tax is a test assumption of 8%."],
  lines: [
    furniture({ itemId: SOFA, name: "Three-seat sofa", vendor: NORTHWOOD, room: "Living room", sku: "NW-SOFA-3", quantity: 1, unitPriceCents: 80_000, taxCents: 6_400, freightCents: 10_000 }),
    furniture({ itemId: CHAIR, name: "Dining chair", vendor: NORTHWOOD, room: "Dining room", sku: "NW-CHAIR", quantity: 4, unitPriceCents: 8_000, taxCents: 2_560 }),
    furniture({ itemId: DESK, name: "Writing desk", vendor: BRIGHTDESK, room: "Study", sku: "BD-DESK", quantity: 1, unitPriceCents: 25_000, taxCents: 2_000 }),
    furniture({ itemId: TILE, name: "Porcelain floor tile", vendor: STONEWARE, room: "Entry", sku: "ST-TILE", quantity: 5, unitLabel: "box", unitPriceCents: 4_500, taxCents: 1_800 }),
    service({ itemId: CONSULTATION, name: "Design consultation", sku: "LS-CONSULT", quantity: 2, unitPriceCents: 15_000 }),
    service({ itemId: PLANNING, name: "Space planning", sku: "LS-PLAN", quantity: 4, unitPriceCents: 12_500 }),
  ],
};

export const testProject: NewProject = { name: "Fernhill Apartment", subtitle: "Living and dining", startsFrom: "draft_quote", quote: testQuote };

/** Adds the test project, with its unsent V1, to the studio (or demo session). */
export function addTestProject(db: Pick<Db, "insert" | "select">, studioId: string): Promise<void> {
  return insertProject(db, studioId, TEST_KEY, testProject);
}

/** The V1 with every line approved by the client, for tests that need no database. */
export function approvedTestQuote(approvedAt?: string): ApprovedQuoteReport {
  return approvedForTest(testQuote, approvedAt);
}

/** One of the V1 lines. */
export function testLine(itemId: string): QuoteLine {
  const line = testQuote.lines.find((entry) => entry.itemId === itemId);
  if (!line) throw new Error(`The test quote has no line ${itemId}`);
  return line;
}
