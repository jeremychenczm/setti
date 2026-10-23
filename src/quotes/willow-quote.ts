import type { QuoteDocument, QuoteLine } from "./types";

const checkedAt = "2026-10-17";

/** Four fictional suppliers, each with the quote document the designer received from them. */
interface Supplier {
  name: string;
  quoteNumber: string;
  returnPolicy: string;
}

const alderRow: Supplier = {
  name: "Alder Row Furniture (demo)",
  quoteNumber: "ARF-Q-2611",
  returnPolicy: "Demo supplier terms: unused items in their original packaging may be returned within 30 days of delivery. The supplier has not confirmed a restocking fee. Verify eligibility and condition before promising a refund.",
};
const quillmark: Supplier = {
  name: "Quillmark Office (demo)",
  quoteNumber: "QMO-Q-0418",
  returnPolicy: "Demo supplier terms: unassembled items may be returned within 30 days of delivery. Assembled furniture needs the supplier's approval. No restocking fee has been confirmed.",
};
const larkspur: Supplier = {
  name: "Larkspur Lighting (demo)",
  quoteNumber: "LKL-Q-0907",
  returnPolicy: "Demo supplier terms: unopened fixtures and bulbs may be returned within 30 days. Opened bulbs and installed fixtures need the supplier's approval. No restocking fee has been confirmed.",
};
const saltmarsh: Supplier = {
  name: "Saltmarsh Textiles (demo)",
  quoteNumber: "SMT-Q-1123",
  returnPolicy: "Demo supplier terms: unused rugs and textiles may be returned within 30 days. Clearance items are final sale unless the supplier agrees otherwise. No restocking fee has been confirmed.",
};

interface ProductInput {
  itemId: string;
  name: string;
  room: string;
  sku: string;
  specification: string;
  quantity: number;
  unitPriceCents: number;
  unitLabel?: string;
  priceNote?: string;
  freightCents?: number;
}

function product(supplier: Supplier, input: ProductInput): QuoteLine {
  const subtotalCents = input.quantity * input.unitPriceCents;
  return {
    itemId: input.itemId,
    name: input.name,
    vendor: supplier.name,
    category: "furniture",
    room: input.room,
    sku: input.sku,
    specification: input.specification,
    quantity: input.quantity,
    unitLabel: input.unitLabel ?? "each",
    unitPriceCents: input.unitPriceCents,
    // Test-only assumption: 8.75% on each merchandise line, rounded to cents.
    taxCents: Math.round((subtotalCents * 875) / 10_000),
    freightCents: input.freightCents ?? 0,
    source: {
      kind: "demo",
      reference: `${supplier.quoteNumber} · ${input.sku}`,
      name: `${supplier.name.replace(" (demo)", "")} quote ${supplier.quoteNumber}`,
      note: "Fictional supplier quote used as demo data. The supplier, product, SKU, price and terms are invented; this is not a real offer.",
      checkedAt,
      priceNote: input.priceNote ?? "Supplier quote price dated October 17, 2026. Stock and the final price are confirmed when the order is placed.",
    },
    leadTimeDays: null,
    returnPolicy: supplier.returnPolicy,
    restockingFeeBps: null,
    customMade: false,
    nonReturnable: null,
  };
}

interface ServiceInput {
  itemId: string;
  name: string;
  sku: string;
  specification: string;
  hours: number;
  hourlyRateCents: number;
}

function service(input: ServiceInput): QuoteLine {
  return {
    itemId: input.itemId,
    name: input.name,
    vendor: "Lee Studio (simulated estimate)",
    category: "service",
    room: "Whole home",
    sku: input.sku,
    specification: input.specification,
    quantity: input.hours,
    unitLabel: "hour",
    unitPriceCents: input.hourlyRateCents,
    taxCents: 0,
    freightCents: 0,
    source: {
      kind: "estimate",
      reference: input.sku,
      name: "Simulated studio service estimate",
      note: "Test-only hours and hourly rate. This is not a supplier quote or an actual design studio's published fee.",
      priceNote: "Simulated estimate; 0% service tax is a test assumption only.",
    },
    leadTimeDays: null,
    returnPolicy: "Simulated service estimate. No service has been performed; cancellation eligibility and any earned fee require a separate agreed scope and review of work actually completed.",
    restockingFeeBps: null,
    customMade: false,
    nonReturnable: null,
  };
}

const merchandise: QuoteLine[] = [
  product(alderRow, {
    itemId: "willow-sofa", name: "Three-seat sofa", room: "Living room", sku: "ARF-SOFA-3S-BG",
    specification: "Beige-gray woven fabric · 89 3/4 W × 37 3/8 D × 32 5/8 H in",
    quantity: 1, unitPriceCents: 79_900, freightCents: 9_900,
  }),
  product(alderRow, {
    itemId: "willow-armchair", name: "Lounge armchair", room: "Living room", sku: "ARF-ARM-BIR-LB",
    specification: "Bent birch frame · light beige cushion",
    quantity: 1, unitPriceCents: 14_900,
  }),
  product(alderRow, {
    itemId: "willow-coffee-table", name: "Walnut coffee table", room: "Living room", sku: "ARF-CT-WAL-71",
    specification: "Walnut veneer · 70 7/8 × 23 1/4 in",
    quantity: 1, unitPriceCents: 44_999,
  }),
  product(alderRow, {
    itemId: "willow-side-table", name: "Round side table", room: "Living room", sku: "ARF-ST-BLK-15",
    specification: "Black steel · 15 in diameter · tabletop height 17 3/4 in; 30 3/4 in including handle",
    quantity: 1, unitPriceCents: 4_499,
  }),
  product(alderRow, {
    itemId: "willow-media-console", name: "Media console with doors", room: "Living room", sku: "ARF-MC-WHT-71",
    specification: "White · 70 7/8 × 16 1/2 × 15 in · two doors",
    quantity: 1, unitPriceCents: 22_500,
  }),
  product(alderRow, {
    itemId: "willow-entry-shelf", name: "Glass-door shelf unit", room: "Entry", sku: "ARF-SH-BBG-39",
    specification: "Black-brown steel / glass · 39 3/8 W × 68 7/8 H in",
    quantity: 1, unitPriceCents: 12_900,
  }),
  product(larkspur, {
    itemId: "willow-floor-lamp", name: "Floor lamp", room: "Living room", sku: "LKL-FL-ASH-15",
    specification: "Ash / white shade · adjustable height 47–59 in · shade width 15 in · E26 bulb sold separately",
    quantity: 1, unitPriceCents: 7_999,
  }),
  product(larkspur, {
    itemId: "willow-table-lamp", name: "Dimmable table lamp", room: "Entry", sku: "LKL-TL-ANT-10",
    specification: "Anthracite · height 10 in · E12 bulb sold separately; final bulb fit and dimming compatibility need confirmation",
    quantity: 1, unitPriceCents: 3_499,
  }),
  product(saltmarsh, {
    itemId: "willow-area-rug", name: "Low-pile area rug", room: "Living room", sku: "SMT-RUG-OW-610",
    specification: "Off-white · 6 ft 7 in × 9 ft 10 in",
    quantity: 1, unitPriceCents: 12_999,
    priceNote: "Clearance price $129.99, previously $159.99, valid while the supplier's stock lasts. Recheck price and availability before ordering.",
  }),
  product(alderRow, {
    itemId: "willow-dining-table", name: "Dining table", room: "Dining room", sku: "ARF-DT-ASH-55",
    specification: "Ash veneer · 55 1/8 × 30 3/4 in",
    quantity: 1, unitPriceCents: 29_999,
  }),
  product(alderRow, {
    itemId: "willow-dining-chair", name: "Dining chair", room: "Dining room", sku: "ARF-DC-ASH-18",
    specification: "Ash · 18 1/8 W × 20 1/8 D × 31 1/2 H in · price per chair",
    quantity: 4, unitPriceCents: 8_000,
  }),
  product(larkspur, {
    itemId: "willow-pendant-lamp", name: "LED pendant lamp", room: "Dining room", sku: "LKL-PD-WHT-15",
    specification: "Dimmable white spectrum / white · 15 in · wireless remote sold separately",
    quantity: 1, unitPriceCents: 9_999,
  }),
  product(quillmark, {
    itemId: "willow-desk", name: "Writing desk", room: "Home office", sku: "QMO-DSK-WHT-41",
    specification: "White · 41 3/8 × 19 5/8 in",
    quantity: 1, unitPriceCents: 10_999,
  }),
  product(quillmark, {
    itemId: "willow-office-chair", name: "Office chair", room: "Home office", sku: "QMO-OC-BLK-01",
    specification: "Black · base chair without optional armrests · adjustable seat height",
    quantity: 1, unitPriceCents: 9_999,
  }),
  product(quillmark, {
    itemId: "willow-bookcase", name: "Bookcase", room: "Home office", sku: "QMO-BC-WHT-79",
    specification: "White · 31 1/2 × 11 × 79 1/2 in · price per bookcase",
    quantity: 2, unitPriceCents: 7_900,
  }),
  product(alderRow, {
    itemId: "willow-sideboard", name: "Sideboard", room: "Dining room", sku: "ARF-SB-WHT-49",
    specification: "White · 48 7/8 × 19 5/8 × 37 3/8 in",
    quantity: 1, unitPriceCents: 39_900,
  }),
  product(larkspur, {
    itemId: "willow-work-lamp", name: "Work lamp", room: "Home office", sku: "LKL-WL-DGY-07",
    specification: "Dark gray · adjustable arm · 7 in shade · E26 bulb sold separately",
    quantity: 2, unitPriceCents: 1_999,
  }),
  product(alderRow, {
    itemId: "willow-mirror", name: "Wall mirror", room: "Entry", sku: "ARF-MIR-WHT-59",
    specification: "White frame · 15 3/4 × 59 in",
    quantity: 1, unitPriceCents: 6_999,
  }),
  product(saltmarsh, {
    itemId: "willow-cushion-cover", name: "Cushion cover", room: "Living room", sku: "SMT-CC-BLU-20",
    specification: "Blue · 20 × 20 in · cover only, inner cushion quoted separately",
    quantity: 4, unitPriceCents: 799,
    priceNote: "Clearance price $7.99 each, previously $9.99, valid while the supplier's stock lasts. Recheck price and availability before ordering.",
  }),
  product(saltmarsh, {
    itemId: "willow-inner-cushion", name: "Inner cushion", room: "Living room", sku: "SMT-CI-OW-20",
    specification: "Off-white · 20 × 20 in · insert only, cover quoted separately",
    quantity: 4, unitPriceCents: 1_200,
  }),
  product(larkspur, {
    itemId: "willow-bulbs-e26", name: "LED bulb E26, 800 lumen", room: "Living room / Home office", sku: "LKL-B26-800-2P",
    specification: "Dimmable / globe opal · 2 bulbs per pack · 2 packs = 4 bulbs; fixture compatibility needs confirmation",
    quantity: 2, unitLabel: "2-pack", unitPriceCents: 499,
    priceNote: "Supplier price $4.99 per 2-pack, not per bulb. Quoted quantity 2 means 2 packs / 4 bulbs.",
  }),
  product(larkspur, {
    itemId: "willow-bulbs-e12", name: "LED bulb E12, 800 lumen", room: "Entry", sku: "LKL-B12-800-2P",
    specification: "Dimmable / globe opal · 2700 K · 5.9 W · 2 in diameter · 2 bulbs per pack; table lamp fit and dimming compatibility not yet verified",
    quantity: 1, unitLabel: "2-pack", unitPriceCents: 799,
    priceNote: "Supplier price $7.99 per 2-pack, not per bulb. Quoted quantity 1 means 1 pack / 2 bulbs.",
  }),
];

const services: QuoteLine[] = [
  service({ itemId: "willow-consultation", name: "Design consultation", sku: "EST-WILLOW-CONSULT", specification: "Simulated estimate · 2 hours × $150/hour", hours: 2, hourlyRateCents: 15_000 }),
  service({ itemId: "willow-space-planning", name: "Space planning", sku: "EST-WILLOW-PLAN", specification: "Simulated estimate · 8 hours × $150/hour", hours: 8, hourlyRateCents: 15_000 }),
  service({ itemId: "willow-product-selection", name: "Furniture and lighting selection", sku: "EST-WILLOW-SELECT", specification: "Simulated estimate · 10 hours × $125/hour", hours: 10, hourlyRateCents: 12_500 }),
  service({ itemId: "willow-procurement-coordination", name: "Procurement coordination", sku: "EST-WILLOW-PROCURE", specification: "Simulated estimate · 6 hours × $100/hour", hours: 6, hourlyRateCents: 10_000 }),
  service({ itemId: "willow-assembly-coordination", name: "Assembly coordination", sku: "EST-WILLOW-ASSEMBLY", specification: "Simulated estimate · 8 hours × $85/hour · coordination only; supplier assembly is booked separately", hours: 8, hourlyRateCents: 8_500 }),
  service({ itemId: "willow-styling", name: "Room styling", sku: "EST-WILLOW-STYLE", specification: "Simulated estimate · 4 hours × $125/hour", hours: 4, hourlyRateCents: 12_500 }),
];

/**
 * Willow's prepared V1: fictional supplier quotes and simulated studio services.
 * It carries no approval; the client's signed line decisions approve it.
 */
export const willowQuote: QuoteDocument = {
  id: "demo-willow-v1",
  version: 1,
  projectId: "willow",
  projectName: "Willow Residence",
  room: "Living room · Dining room · Home office · Entry",
  clientName: "Sofia Martinez (demo client)",
  designerName: "Jordan Lee (demo designer)",
  currency: "USD",
  isDemo: true,
  demoNotice: "Demo quote with 22 items from four fictional supplier quotes and 6 simulated studio services. The household, suppliers, products, prices and quantities are demonstration data, not real offers.",
  paymentNote: "This quote confirms no payment. No PayPal authorization, charge or refund is represented.",
  assumptions: [
    "Suppliers, product names, SKUs and USD prices come from four fictional supplier quotes dated October 17, 2026. Stock and final prices are confirmed when each order is placed. Regular prices are used unless a line explicitly says clearance.",
    "Merchandise tax is a test assumption of 8.75%, rounded once per line after multiplying quantity by unit price. This is not a conclusion about the applicable tax jurisdiction, taxable items or actual tax due.",
    "One $99 delivery budget allowance is assigned to the first merchandise line only. It is not a supplier delivery quote; destination, order size, delivery eligibility and any delivery tax have not been assessed.",
    "The six service rates and hours are simulated estimates. Zero service tax is a test assumption, not a tax conclusion. Services have not been performed and cancellation terms remain to be agreed.",
    "For bulb rows, quantity counts 2-packs, not individual bulbs. Lamps, bulbs, remote controls and other components require final compatibility and installation review; this report does not certify a complete installation.",
    "Supplier lead times, restocking charges and final return eligibility are unconfirmed. Each line's return terms summarize its supplier's quote and do not promise a refund or a release of funds.",
  ],
  lines: [...merchandise, ...services],
};
