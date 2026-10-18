import type { ApprovedQuoteLine, ApprovedQuoteReport, QuoteLineApproval } from "./types";

const checkedAt = "2026-10-17";
const approvedAt = "2026-10-17T10:30:00-07:00";
const returnPolicyUrl = "https://www.ikea.com/us/en/customer-service/returns-claims/return-policy/";
const productReturnPolicy =
  "IKEA US policy summary: unopened items may be returned within 365 days; opened items within 180 days with proof of purchase, subject to the full policy. Verify eligibility, condition, delivery and receipt details before promising a refund. No refund amount or restocking fee is assumed here.";

function demoApproval(): QuoteLineApproval {
  return {
    status: "approved",
    approvedBy: "Sofia Martinez (demo client)",
    approvedAt,
    signature: "Sofia Martinez (demo signature)",
    isDemo: true,
  };
}

interface ProductInput {
  itemId: string;
  name: string;
  room: string;
  sku: string;
  specification: string;
  quantity: number;
  unitPriceCents: number;
  url: string;
  unitLabel?: string;
  priceNote?: string;
  freightCents?: number;
}

function product(input: ProductInput): ApprovedQuoteLine {
  const subtotalCents = input.quantity * input.unitPriceCents;
  return {
    itemId: input.itemId,
    name: input.name,
    vendor: "IKEA US",
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
      kind: "public_reference",
      reference: `IKEA-US-${input.sku}`,
      name: `${input.name} · IKEA US product page`,
      note: "Official US retail reference price. Quantities and room placement are sample design inputs; this is not a supplier-issued or purchased order.",
      url: input.url,
      checkedAt,
      priceNote: input.priceNote ?? "US product-page reference price checked on October 17, 2026; availability and checkout price are not guaranteed.",
      returnPolicyUrl,
    },
    leadTimeDays: null,
    returnPolicy: productReturnPolicy,
    restockingFeeBps: null,
    customMade: false,
    nonReturnable: null,
    approval: demoApproval(),
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

function service(input: ServiceInput): ApprovedQuoteLine {
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
      note: "Test-only hours and hourly rate. This is not an IKEA service quote or an actual design studio's published fee.",
      priceNote: "Simulated estimate; 0% service tax is a test assumption only.",
    },
    leadTimeDays: null,
    returnPolicy: "Simulated service estimate. No service has been performed; cancellation eligibility and any earned fee require a separate agreed scope and review of work actually completed.",
    restockingFeeBps: null,
    customMade: false,
    nonReturnable: null,
    approval: demoApproval(),
  };
}

const merchandise: ApprovedQuoteLine[] = [
  product({
    itemId: "willow-kivik-sofa", name: "KIVIK Sofa", room: "Living room", sku: "394.405.93",
    specification: "Tibbleby beige/gray · 89 3/4 W × 37 3/8 D × 32 5/8 H in",
    quantity: 1, unitPriceCents: 79_900, freightCents: 9_900,
    url: "https://www.ikea.com/us/en/p/kivik-sofa-tibbleby-beige-gray-s39440593/",
  }),
  product({
    itemId: "willow-poang-armchair", name: "POÄNG Armchair", room: "Living room", sku: "593.059.28",
    specification: "Birch veneer frame / Knisa light beige cushion",
    quantity: 1, unitPriceCents: 14_900,
    url: "https://www.ikea.com/us/en/p/poaeng-armchair-birch-veneer-knisa-light-beige-s59305928/",
    priceNote: "Regular reference price $149. The $99 in-store IKEA Family offer is not assumed.",
  }),
  product({
    itemId: "willow-stockholm-coffee-table", name: "STOCKHOLM Coffee table", room: "Living room", sku: "702.397.10",
    specification: "Walnut veneer · 70 7/8 × 23 1/4 in",
    quantity: 1, unitPriceCents: 44_999,
    url: "https://www.ikea.com/us/en/p/stockholm-coffee-table-walnut-veneer-70239710/",
  }),
  product({
    itemId: "willow-burvik-side-table", name: "BURVIK Side table", room: "Living room", sku: "703.403.84",
    specification: "Black · 15 in diameter · tabletop height 17 3/4 in; 30 3/4 in including handle",
    quantity: 1, unitPriceCents: 4_499,
    url: "https://www.ikea.com/us/en/p/burvik-side-table-black-70340384/",
  }),
  product({
    itemId: "willow-besta-tv-unit", name: "BESTÅ TV unit with doors", room: "Living room", sku: "495.680.48",
    specification: "White / Lappviken white · 70 7/8 × 16 1/2 × 15 in · door combination",
    quantity: 1, unitPriceCents: 22_500,
    url: "https://www.ikea.com/us/en/p/besta-tv-unit-with-doors-white-lappviken-white-s49568048/",
    priceNote: "Regular reference price $225 for this door combination. The $184 IKEA Family offer and the price of a bare frame are not used.",
  }),
  product({
    itemId: "willow-vittsjo-shelf", name: "VITTSJÖ Shelf unit", room: "Entry", sku: "202.133.12",
    specification: "Black-brown / glass · 39 3/8 W × 68 7/8 H in",
    quantity: 1, unitPriceCents: 12_900,
    url: "https://www.ikea.com/us/en/p/vittsjoe-shelf-unit-black-brown-glass-20213312/",
  }),
  product({
    itemId: "willow-lauters-floor-lamp", name: "LAUTERS Floor lamp", room: "Living room", sku: "004.050.48",
    specification: "Ash / white · adjustable height 47–59 in · shade width 15 in · E26 bulb sold separately",
    quantity: 1, unitPriceCents: 7_999,
    url: "https://www.ikea.com/us/en/p/lauters-floor-lamp-ash-white-00405048/",
  }),
  product({
    itemId: "willow-tarnaby-table-lamp", name: "TÄRNABY Table lamp", room: "Entry", sku: "003.238.87",
    specification: "Dimmable anthracite · height 10 in · E12 bulb sold separately; final bulb fit and dimming compatibility need confirmation",
    quantity: 1, unitPriceCents: 3_499,
    url: "https://www.ikea.com/us/en/p/taernaby-table-lamp-dimmable-anthracite-00323887/",
    priceNote: "Regular reference price $34.99. The $27.99 IKEA Family offer is not assumed.",
  }),
  product({
    itemId: "willow-stoense-rug", name: "STOENSE Rug, low pile", room: "Living room", sku: "204.268.08",
    specification: "Off-white · 6 ft 7 in × 9 ft 10 in",
    quantity: 1, unitPriceCents: 12_999,
    url: "https://www.ikea.com/us/en/p/stoense-rug-low-pile-off-white-20426808/",
    priceNote: "Clearance reference price $129.99, previously $159.99; offer began April 21, 2026 and lasts while supplies remain. Recheck price and availability before purchase.",
  }),
  product({
    itemId: "willow-lisabo-dining-table", name: "LISABO Table", room: "Dining room", sku: "702.943.39",
    specification: "Ash veneer · 55 1/8 × 30 3/4 in",
    quantity: 1, unitPriceCents: 29_999,
    url: "https://www.ikea.com/us/en/p/lisabo-table-ash-veneer-70294339/",
  }),
  product({
    itemId: "willow-lisabo-dining-chair", name: "LISABO Chair", room: "Dining room", sku: "004.572.35",
    specification: "Ash · 18 1/8 W × 20 1/8 D × 31 1/2 H in · price per chair",
    quantity: 4, unitPriceCents: 8_000,
    url: "https://www.ikea.com/us/en/p/lisabo-chair-ash-00457235/",
  }),
  product({
    itemId: "willow-nymane-pendant", name: "NYMÅNE LED pendant lamp", room: "Dining room", sku: "805.038.32",
    specification: "Wireless dimmable white spectrum / white · 15 in · remote and hub sold separately",
    quantity: 1, unitPriceCents: 9_999,
    url: "https://www.ikea.com/us/en/p/nymane-led-pendant-lamp-wireless-dimmable-white-spectrum-white-80503832/",
  }),
  product({
    itemId: "willow-micke-desk", name: "MICKE Desk", room: "Home office", sku: "802.130.74",
    specification: "White · 41 3/8 × 19 5/8 in",
    quantity: 1, unitPriceCents: 10_999,
    url: "https://www.ikea.com/us/en/p/micke-desk-white-80213074/",
  }),
  product({
    itemId: "willow-flintan-office-chair", name: "FLINTAN Office chair", room: "Home office", sku: "904.890.29",
    specification: "Black · base chair without optional armrests · adjustable seat height",
    quantity: 1, unitPriceCents: 9_999,
    url: "https://www.ikea.com/us/en/p/flintan-office-chair-black-90489029/",
  }),
  product({
    itemId: "willow-billy-bookcase", name: "BILLY Bookcase", room: "Home office", sku: "205.220.46",
    specification: "White · 31 1/2 × 11 × 79 1/2 in · price per bookcase",
    quantity: 2, unitPriceCents: 7_900,
    url: "https://www.ikea.com/us/en/p/billy-bookcase-white-20522046/",
    priceNote: "Regular reference price $79 each. The $65 in-store IKEA Family offer is not assumed.",
  }),
  product({
    itemId: "willow-idanas-sideboard", name: "IDANÄS Sideboard", room: "Dining room", sku: "605.096.27",
    specification: "White · 48 7/8 × 19 5/8 × 37 3/8 in",
    quantity: 1, unitPriceCents: 39_900,
    url: "https://www.ikea.com/us/en/p/idanaes-sideboard-white-60509627/",
  }),
  product({
    itemId: "willow-tertial-work-lamp", name: "TERTIAL Work lamp", room: "Home office", sku: "203.554.34",
    specification: "Dark gray · adjustable arm · 7 in shade · E26 bulb sold separately",
    quantity: 2, unitPriceCents: 1_999,
    url: "https://www.ikea.com/us/en/p/tertial-work-lamp-dark-gray-20355434/",
  }),
  product({
    itemId: "willow-nissedal-mirror", name: "NISSEDAL Mirror", room: "Entry", sku: "905.037.75",
    specification: "White · 15 3/4 × 59 in",
    quantity: 1, unitPriceCents: 6_999,
    url: "https://www.ikea.com/us/en/p/nissedal-mirror-white-90503775/",
  }),
  product({
    itemId: "willow-sanela-cushion-cover", name: "SANELA Cushion cover", room: "Living room", sku: "405.909.30",
    specification: "Blue · 20 × 20 in · cover only, inner cushion sold separately",
    quantity: 4, unitPriceCents: 799,
    url: "https://www.ikea.com/us/en/p/sanela-cushion-cover-blue-40590930/",
    priceNote: "Clearance reference price $7.99 each, previously $9.99; offer began April 21, 2026 and lasts while supplies remain. Recheck price and availability before purchase.",
  }),
  product({
    itemId: "willow-fjadrar-inner-cushion", name: "FJÄDRAR Inner cushion", room: "Living room", sku: "602.621.88",
    specification: "Off-white · 20 × 20 in · insert only, cover quoted separately",
    quantity: 4, unitPriceCents: 1_200,
    url: "https://www.ikea.com/us/en/p/fjaedrar-inner-cushion-off-white-60262188/",
  }),
  product({
    itemId: "willow-solhetta-e26-bulbs", name: "SOLHETTA LED bulb E26 800 lumen", room: "Living room / Home office", sku: "205.839.35",
    specification: "Dimmable / globe opal · 2 bulbs per pack · 2 packs = 4 bulbs; fixture compatibility needs confirmation",
    quantity: 2, unitLabel: "2-pack", unitPriceCents: 499,
    url: "https://www.ikea.com/us/en/p/solhetta-led-bulb-e26-800-lumen-dimmable-globe-opal-20583935/",
    priceNote: "Reference price $4.99 per 2-pack, not per bulb. Quoted quantity 2 means 2 packs / 4 bulbs.",
  }),
  product({
    itemId: "willow-solhetta-e12-bulbs", name: "SOLHETTA LED bulb E12 800 lm", room: "Entry", sku: "005.504.98",
    specification: "Dimmable / globe opal · 2700 K · 5.9 W · 2 in diameter · 2 bulbs per pack; TÄRNABY fit and dimming compatibility not yet verified",
    quantity: 1, unitLabel: "2-pack", unitPriceCents: 799,
    url: "https://www.ikea.com/us/en/p/solhetta-led-bulb-e12-800-lm-dimmable-globe-opal-00550498/",
    priceNote: "Reference price $7.99 per 2-pack, not per bulb. Quoted quantity 1 means 1 pack / 2 bulbs.",
  }),
];

const services: ApprovedQuoteLine[] = [
  service({ itemId: "willow-consultation", name: "Design consultation", sku: "EST-WILLOW-CONSULT", specification: "Simulated estimate · 2 hours × $150/hour", hours: 2, hourlyRateCents: 15_000 }),
  service({ itemId: "willow-space-planning", name: "Space planning", sku: "EST-WILLOW-PLAN", specification: "Simulated estimate · 8 hours × $150/hour", hours: 8, hourlyRateCents: 15_000 }),
  service({ itemId: "willow-product-selection", name: "Furniture and lighting selection", sku: "EST-WILLOW-SELECT", specification: "Simulated estimate · 10 hours × $125/hour", hours: 10, hourlyRateCents: 12_500 }),
  service({ itemId: "willow-procurement-coordination", name: "Procurement coordination", sku: "EST-WILLOW-PROCURE", specification: "Simulated estimate · 6 hours × $100/hour", hours: 6, hourlyRateCents: 10_000 }),
  service({ itemId: "willow-assembly-coordination", name: "Assembly coordination", sku: "EST-WILLOW-ASSEMBLY", specification: "Simulated estimate · 8 hours × $85/hour · coordination only; no IKEA assembly booking", hours: 8, hourlyRateCents: 8_500 }),
  service({ itemId: "willow-styling", name: "Room styling", sku: "EST-WILLOW-STYLE", specification: "Simulated estimate · 4 hours × $125/hour", hours: 4, hourlyRateCents: 12_500 }),
];

/** Retail prices are referenced; the design plan, allowances and approval are simulated. */
export const willowApprovedQuote: ApprovedQuoteReport = {
  id: "demo-willow-v1",
  version: 1,
  projectId: "willow",
  projectName: "Willow Residence",
  room: "Living room · Dining room · Home office · Entry",
  clientName: "Sofia Martinez (demo client)",
  designerName: "Jordan Lee (demo designer)",
  currency: "USD",
  status: "approved",
  approvedAt,
  approvedBy: "Sofia Martinez (demo client)",
  signature: "Sofia Martinez (demo signature)",
  isDemo: true,
  demoNotice: "Test quote with 22 real IKEA US product references and 6 simulated studio services. The household, design choices, quantities, approval date and signature are demonstration data. This is not an IKEA-issued quote or a real client approval.",
  paymentNote: "Quote approval is simulated and confirms no real payment. No PayPal authorization, charge or refund is represented.",
  assumptions: [
    "Product names, selected options, SKUs and USD reference prices were checked against IKEA US product pages on October 17, 2026. Prices and stock must be checked again at purchase. Regular prices are used unless a line explicitly says clearance; IKEA Family eligibility is not assumed.",
    "Merchandise tax is a test assumption of 8.75%, rounded once per line after multiplying quantity by unit price. This is not a conclusion about the applicable tax jurisdiction, taxable items or actual tax due.",
    "One $99 delivery budget allowance is assigned to the first merchandise line only. It is not an IKEA delivery quote; destination, order size, delivery eligibility and any delivery tax have not been assessed.",
    "The six service rates and hours are simulated estimates, not IKEA prices. Zero service tax is a test assumption, not a tax conclusion. Services have not been performed and cancellation terms remain to be agreed.",
    "For bulb rows, quantity counts 2-packs, not individual bulbs. Lamps, bulbs, remote controls and other components require final compatibility and installation review; this report does not certify a complete installation.",
    "Vendor delivery lead times, restocking charges and final return eligibility are unconfirmed. The policy summary links to IKEA US terms and does not promise a refund or a release of funds.",
  ],
  lines: [...merchandise, ...services],
};
