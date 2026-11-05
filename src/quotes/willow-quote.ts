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
const fieldstone: Supplier = {
  name: "Fieldstone Floor & Tile (demo)",
  quoteNumber: "FFT-Q-0612",
  returnPolicy: "Demo supplier terms: full, unopened boxes may be returned within 30 days of delivery. Opened boxes and cut pieces cannot be returned. No restocking fee has been confirmed.",
};
const harborPaint: Supplier = {
  name: "Harbor Paint Co (demo)",
  quoteNumber: "HPC-Q-0215",
  returnPolicy: "Demo supplier terms: paint is tinted to order and cannot be returned once mixed. Unopened, untinted products may be returned within 30 days.",
};
const pinecrest: Supplier = {
  name: "Pinecrest Millwork (demo)",
  quoteNumber: "PCM-Q-0730",
  returnPolicy: "Demo supplier terms: built to site measurements and cannot be returned once fabrication starts. Changes after the shop drawing is approved need a revised quote.",
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
  leadTimeDays?: number;
  customMade?: boolean;
  nonReturnable?: boolean;
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
    leadTimeDays: input.leadTimeDays ?? null,
    returnPolicy: supplier.returnPolicy,
    restockingFeeBps: null,
    customMade: input.customMade ?? false,
    nonReturnable: input.nonReturnable ?? null,
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
  product(fieldstone, {
    itemId: "willow-oak-flooring", name: "Engineered oak flooring", room: "Living room / Dining room", sku: "FFT-EOK-NAT-75",
    specification: "Natural white oak, matte · 7 1/2 in wide planks, 1/2 in thick, click-lock floating floor · 23.3 sq ft per box · 20 boxes = 466 sq ft for about 420 sq ft of floor plus 10% for cuts · underlayment and installation by the client's contractor",
    quantity: 20, unitLabel: "box", unitPriceCents: 9_996,
    priceNote: "Supplier price $99.96 per box ($4.29 per sq ft). Quoted quantity counts boxes, not square feet.",
  }),
  product(fieldstone, {
    itemId: "willow-entry-tile", name: "Porcelain floor tile", room: "Entry", sku: "FFT-POR-GRY-1224",
    specification: "Warm gray matte porcelain · 12 × 24 in · 8 tiles per box = 15.5 sq ft · 4 boxes = 62 sq ft for about 55 sq ft of floor plus 10% for cuts · setting materials, grout and installation by the client's contractor",
    quantity: 4, unitLabel: "box", unitPriceCents: 4_635,
    priceNote: "Supplier price $46.35 per box ($2.99 per sq ft). Quoted quantity counts boxes, not square feet.",
  }),
  product(harborPaint, {
    itemId: "willow-wall-paint", name: "Interior wall paint", room: "Living room · Dining room · Home office · Entry", sku: "HPC-INT-EGG-WW",
    specification: "Eggshell acrylic, tinted to the approved warm white · about 350–400 sq ft per gallon per coat · 9 gallons for two coats on about 1,600 sq ft of walls · ceilings, trim, primer and painting labor not included",
    quantity: 9, unitLabel: "gallon", unitPriceCents: 6_899,
    customMade: true, nonReturnable: true,
  }),
  product(larkspur, {
    itemId: "willow-downlights", name: "Recessed LED downlight", room: "Living room", sku: "LKL-RDL-4IN-5CC",
    specification: "4 in canless wafer, IC-rated, dimmable · selectable 2700–5000 K · price per light · 6 lights; a licensed electrician installs them and confirms dimmer compatibility",
    quantity: 6, unitPriceCents: 3_299,
  }),
  product(pinecrest, {
    itemId: "willow-office-shelving", name: "Built-in wall shelving", room: "Home office", sku: "PCM-BIS-96-PG",
    specification: "Paint-grade birch plywood, painted to match the walls · 96 W × 12 D × 48 H in above the desk · adjustable shelves · fabricated to site measurements and delivered ready to fit; installation by the client's contractor",
    quantity: 1, unitPriceCents: 320_000, leadTimeDays: 35,
    customMade: true, nonReturnable: true,
    priceNote: "Supplier price for fabrication and delivery, based on the designer's site measurements. Fabrication starts after the shop drawing is approved.",
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
  demoNotice: "Demo quote with 20 items (furniture, lighting and finish materials) from seven fictional supplier quotes and 6 simulated studio services. The household, suppliers, products, prices and quantities are demonstration data, not real offers.",
  paymentNote: "This quote confirms no payment. No PayPal authorization, charge or refund is represented.",
  assumptions: [
    "Suppliers, product names, SKUs and USD prices come from seven fictional supplier quotes dated October 17, 2026. Stock and final prices are confirmed when each order is placed. Regular prices are used unless a line explicitly says clearance.",
    "Merchandise tax is a test assumption of 8.75%, rounded once per line after multiplying quantity by unit price. This is not a conclusion about the applicable tax jurisdiction, taxable items or actual tax due.",
    "One $99 delivery budget allowance is assigned to the first merchandise line only. It is not a supplier delivery quote; destination, order size, delivery eligibility and any delivery tax have not been assessed.",
    "The six service rates and hours are simulated estimates. Zero service tax is a test assumption, not a tax conclusion. Services have not been performed and cancellation terms remain to be agreed.",
    "Finish materials are supply only. Flooring and tile count boxes and include about 10% for cuts; paint counts gallons. Installation, site preparation, setting materials and electrical work are by the client's contractor and are not part of this quote.",
    "Light fixtures and downlights need final compatibility and installation review by a licensed electrician; this report does not certify a complete installation.",
    "Lead times are unconfirmed except the built-in shelving's 35-day fabrication time. Tinted paint and the built-in shelving are made to order and cannot be returned. Restocking charges and other return eligibility are unconfirmed; each line's return terms summarize its supplier's quote and do not promise a refund or a release of funds.",
  ],
  lines: [...merchandise, ...services],
};
