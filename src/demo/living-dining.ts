import type { ApprovedQuoteLine, ApprovedQuoteReport, QuoteLineApproval } from "@/quotes/types";

/**
 * The current walkthrough: Maple Ave Café's counter and back-bar refit. The scenario keeps its saved
 * name; version 4 replaced the earlier living-and-dining story and version 5 added the V1 lines the
 * revision leaves alone, so a run saved under an earlier version stops with "not supported" instead
 * of preparing money against a different V1.
 */
export const HOME_SCENARIO = "maple-living-dining-v3" as const;
export const HOME_SCENARIO_VERSION = 5;
export function isHomeScenario(value: string | undefined): boolean {
  return value === HOME_SCENARIO;
}
/** V1's product lines, each held on its own. */
export const HOME_ITEM_IDS = ["countertop", "wall-tile", "shelving", "mirror", "pendants", "stools"] as const;
/** Lines whose suppliers needed paying before the design changed: their orders are confirmed and V1 captured them. */
export const HOME_EARLY_ITEMS = ["countertop", "wall-tile", "shelving", "mirror"] as const;
/** The studio's services and the trades' fixed-fee work, paid together at signing. */
export const HOME_SERVICE_IDS = ["design", "site-visits", "plumbing", "electrical", "painting", "strip-out", "site-protection", "permit"] as const;

const approvedAt = "2026-10-03T15:00:00-07:00";
const room = "Front of house";
const approval: QuoteLineApproval = {
  status: "approved", approvedBy: "Emma Park", approvedAt,
  signature: "Emma Park (demo signature)", isDemo: true,
};

type Product = Omit<ApprovedQuoteLine, "category" | "room" | "taxCents" | "freightCents" | "approval" | "customMade" | "nonReturnable"> & Partial<Pick<ApprovedQuoteLine, "customMade" | "nonReturnable">>;
function product(line: Product): ApprovedQuoteLine {
  return { customMade: false, nonReturnable: false, ...line, category: "furniture", room, taxCents: 0, freightCents: 0, approval: { ...approval } };
}
function service(line: Omit<ApprovedQuoteLine, "category" | "room" | "taxCents" | "freightCents" | "approval" | "customMade" | "nonReturnable" | "restockingFeeBps" | "leadTimeDays">): ApprovedQuoteLine {
  return { ...line, category: "service", room, taxCents: 0, freightCents: 0, leadTimeDays: null, restockingFeeBps: 0, customMade: false, nonReturnable: false, approval: { ...approval } };
}

/** Fictional agreed baseline. It contains no PayPal resource IDs or payment-state claims. */
export const HOME_APPROVED_QUOTE: ApprovedQuoteReport = {
  id: "demo-maple-cafe-v1", version: 1, projectId: "maple", projectName: "Maple Ave Café", room,
  clientName: "Emma Park", designerName: "Jordan Lee", currency: "USD", status: "approved",
  approvedAt, approvedBy: "Emma Park", signature: "Emma Park (demo signature)", isDemo: true,
  demoNotice: "Fictional Maple Ave Café counter and back-bar example. Clients, suppliers, products, source references, dates, terms and signatures are demonstration data; no source reference identifies a real supplier document.",
  paymentNote: "Agreed prices only. Approval does not confirm that any PayPal hold, charge or refund exists; consult the saved payment records.",
  assumptions: [
    "All prices are USD. Every line has USD 0 tax and USD 0 delivery as explicit demo assumptions, not a tax calculation or a supplier promise of free delivery.",
    "Each supplier reference identifies fictional local scenario material, not an uploaded or externally verified document. Dimensions, lead times and return terms are illustrative.",
    "Countertop quantities are linear feet of fabricated top; tile quantities are boxes covering the measured wall area plus a cutting allowance.",
    "The fixed USD 2,400 design fee covers the concept, layout and construction drawings; site visits during installation are billed per visit.",
    "The plumbing, electrical, painting, strip-out, site protection and permit work are each one fixed fee for the work described.",
    "The example approval date and typed signature do not represent a real client's signature.",
  ],
  lines: [
    service({
      itemId: "design", name: "Design services", vendor: "Lee Studio (demo)",
      sku: "DEMO-CAFE-DESIGN-01", specification: "Concept, counter and back-bar layout, and construction drawings; fixed scope and fee",
      quantity: 1, unitLabel: "fixed fee", unitPriceCents: 240_000,
      source: { kind: "demo", reference: "MAPLE-CAFE-SERVICE-01", name: "Fictional studio service agreement",
        note: "Local fictional scenario terms; not an uploaded or supplier-issued agreement.", priceNote: "One fixed fee of USD 2,400." },
      returnPolicy: "Fictional service terms: the fixed design fee covers the agreed concept, layout and drawings; any change to that scope needs a separate review.",
    }),
    service({
      itemId: "site-visits", name: "Site visits during installation", vendor: "Lee Studio (demo)",
      sku: "DEMO-CAFE-VISIT", specification: "One site visit of up to two hours during installation, with written notes for the installers",
      quantity: 4, unitLabel: "visit", unitPriceCents: 18_000,
      source: { kind: "demo", reference: "MAPLE-CAFE-SERVICE-02", name: "Fictional studio site-visit rate",
        note: "Local fictional per-visit rate; the quantity is a count of visits.", priceNote: "Four visits at USD 180 each, USD 720 total." },
      returnPolicy: "Fictional service terms: visits are billed per visit; an unused visit is refunded at the per-visit rate.",
    }),
    service({
      itemId: "plumbing", name: "Plumbing hookup for the bar sink", vendor: "Northside Plumbing (demo)",
      sku: "DEMO-CAFE-PLUMB-SINK", specification: "Connect the back bar sink to the existing supply and drain, with two shut-off valves and a leak test",
      quantity: 1, unitLabel: "fixed fee", unitPriceCents: 42_000,
      source: { kind: "demo", reference: "MAPLE-CAFE-PLUMB-01", name: "Fictional Northside Plumbing quote",
        note: "Local fictional fixed-fee terms; not an uploaded or supplier-issued quote.", priceNote: "One fixed fee of USD 420." },
      returnPolicy: "Fictional service terms: one fixed fee for the hookup described; other plumbing work needs a separate quote.",
    }),
    service({
      itemId: "electrical", name: "Electrical: two counter outlets", vendor: "Brightline Electric (demo)",
      sku: "DEMO-CAFE-ELEC-GFCI-2", specification: "Two 20 A GFCI outlets under the back bar counter for the espresso machine and grinder, on a new circuit from the existing panel",
      quantity: 1, unitLabel: "fixed fee", unitPriceCents: 38_000,
      source: { kind: "demo", reference: "MAPLE-CAFE-ELEC-01", name: "Fictional Brightline Electric quote",
        note: "Local fictional fixed-fee terms; not an uploaded or supplier-issued quote.", priceNote: "One fixed fee of USD 380." },
      returnPolicy: "Fictional service terms: one fixed fee for the two outlets and their circuit; other electrical work needs a separate quote.",
    }),
    service({
      itemId: "painting", name: "Side wall paint, two walls", vendor: "Fresh Coat Painters (demo)",
      sku: "DEMO-CAFE-PAINT-2W", specification: "Prep and two coats of washable eggshell paint, warm white, on the left and right walls of the seating area",
      quantity: 1, unitLabel: "fixed fee", unitPriceCents: 68_000,
      source: { kind: "demo", reference: "MAPLE-CAFE-PAINT-01", name: "Fictional Fresh Coat Painters quote",
        note: "Local fictional fixed-fee terms; not an uploaded or supplier-issued quote.", priceNote: "One fixed fee of USD 680." },
      returnPolicy: "Fictional service terms: one fixed fee for the two walls described, including paint and prep; touch-ups within 30 days are included.",
    }),
    service({
      itemId: "strip-out", name: "Old fixture removal and disposal", vendor: "Lee Studio (demo)",
      sku: "DEMO-CAFE-STRIPOUT", specification: "Remove the old counter, shelves and light fittings, and take them to a recycling and disposal site",
      quantity: 1, unitLabel: "fixed fee", unitPriceCents: 35_000,
      source: { kind: "demo", reference: "MAPLE-CAFE-SERVICE-03", name: "Fictional studio strip-out terms",
        note: "Local fictional fixed-fee terms; not an uploaded or supplier-issued agreement.", priceNote: "One fixed fee of USD 350." },
      returnPolicy: "Fictional service terms: one fixed fee for removing and disposing of the old fixtures described.",
    }),
    service({
      itemId: "site-protection", name: "Site protection and final clean", vendor: "Lee Studio (demo)",
      sku: "DEMO-CAFE-PROTECT", specification: "Floor and doorway protection for the length of the installation, then one final clean before reopening",
      quantity: 1, unitLabel: "fixed fee", unitPriceCents: 29_000,
      source: { kind: "demo", reference: "MAPLE-CAFE-SERVICE-04", name: "Fictional studio site-care terms",
        note: "Local fictional fixed-fee terms; not an uploaded or supplier-issued agreement.", priceNote: "One fixed fee of USD 290." },
      returnPolicy: "Fictional service terms: one fixed fee for the protection and the final clean described.",
    }),
    service({
      itemId: "permit", name: "Permit filing and inspection", vendor: "Lee Studio (demo)",
      sku: "DEMO-CAFE-PERMIT", specification: "Prepare and file the city tenant improvement permit and attend its final inspection",
      quantity: 1, unitLabel: "fixed fee", unitPriceCents: 26_000,
      source: { kind: "demo", reference: "MAPLE-CAFE-SERVICE-05", name: "Fictional studio permit terms",
        note: "Local fictional fixed-fee terms; not an uploaded or supplier-issued agreement.", priceNote: "One fixed fee of USD 260." },
      returnPolicy: "Fictional service terms: one fixed fee for filing the permit and attending one inspection.",
    }),
    product({
      itemId: "countertop", name: "Quartz countertop", vendor: "Stoneline Fabrication (demo)", sku: "DEMO-CAFE-QUARTZ-30",
      specification: "3 cm honed white quartz, 25 in deep, fabricated and installed; front counter 14 ft and back bar 8 ft",
      quantity: 22, unitLabel: "linear ft", unitPriceCents: 18_000, customMade: true, nonReturnable: true,
      source: { kind: "demo", reference: "MAPLE-CAFE-QUARTZ-01", name: "Fictional Stoneline countertop quote",
        note: "Local fictional per-foot price and re-cut terms; the quantity is linear feet of fabricated top.", priceNote: "22 linear feet at USD 180 per foot, USD 3,960 total; tax USD 0 and delivery USD 0 (demo assumptions)." },
      leadTimeDays: 14, restockingFeeBps: null,
      returnPolicy: "Fictional terms: tops are templated and cut to size, so payment is due at templating. A cut top cannot be returned or lengthened; it can be re-cut shorter for the fabricator's fixed re-cut fee, with the removed length credited at the per-foot price.",
    }),
    product({
      itemId: "wall-tile", name: "Back bar wall tile", vendor: "Glaze & Co. Tile (demo)", sku: "DEMO-CAFE-TILE-WHT-4",
      specification: "4 × 4 in ceramic tile, white gloss glaze; one box covers 10 sq ft; back bar wall 120 sq ft plus 10% for cuts",
      quantity: 14, unitLabel: "box", unitPriceCents: 7_000,
      source: { kind: "demo", reference: "MAPLE-CAFE-TILE-01", name: "Fictional Glaze & Co. tile quote",
        note: "Local fictional per-box price, coverage and return terms; the quantity is a count of boxes.", priceNote: "14 boxes at USD 70 per box, USD 980 total; tax USD 0 and delivery USD 0 (demo assumptions)." },
      leadTimeDays: 10, restockingFeeBps: 2_000,
      returnPolicy: "Fictional terms: delivered to site and paid on delivery. Unopened boxes may be returned within 30 days of delivery with prior approval, with a 20% restocking fee on the returned goods price.",
    }),
    product({
      itemId: "shelving", name: "Back bar oak shelving", vendor: "Birch Line Joinery (demo)", sku: "DEMO-CAFE-OAK-SHELF-8",
      specification: "Solid oak shelf, 8 ft long and 10 in deep, oiled, on concealed steel brackets; three shelves for the back bar",
      quantity: 3, unitLabel: "shelf", unitPriceCents: 26_000, customMade: true, nonReturnable: true,
      source: { kind: "demo", reference: "MAPLE-CAFE-SHELF-01", name: "Fictional Birch Line shelving quote",
        note: "Local fictional per-shelf price and terms; the quantity is a count of shelves.", priceNote: "Three shelves at USD 260 each, USD 780 total; tax USD 0 and delivery USD 0 (demo assumptions)." },
      leadTimeDays: 14, restockingFeeBps: null,
      returnPolicy: "Fictional terms: made to measure and paid on delivery. Delivered shelves cannot be returned.",
    }),
    product({
      itemId: "mirror", name: "Back bar mirror", vendor: "Clearline Glass (demo)", sku: "DEMO-CAFE-MIRROR-3660",
      specification: "36 × 60 in mirror, 1/4 in glass with polished edges, in a black steel frame; hung above the back bar shelves",
      quantity: 1, unitLabel: "each", unitPriceCents: 54_000, customMade: true, nonReturnable: true,
      source: { kind: "demo", reference: "MAPLE-CAFE-MIRROR-01", name: "Fictional Clearline Glass mirror quote",
        note: "Local fictional price and terms for one framed mirror.", priceNote: "One mirror at USD 540; tax USD 0 and delivery USD 0 (demo assumptions)." },
      leadTimeDays: 10, restockingFeeBps: null,
      returnPolicy: "Fictional terms: cut to size and paid on delivery. A delivered mirror cannot be returned.",
    }),
    product({
      itemId: "pendants", name: "Counter pendant light", vendor: "Lumen Row Lighting (demo)", sku: "DEMO-CAFE-PENDANT-9",
      specification: "9 in opal glass pendant, brushed brass, dimmable; hung over the front counter",
      quantity: 6, unitLabel: "each", unitPriceCents: 24_000,
      source: { kind: "demo", reference: "MAPLE-CAFE-PENDANT-01", name: "Fictional Lumen Row pendant quote",
        note: "Local fictional per-light price and order terms; the quantity is a count of lights.", priceNote: "Six pendants at USD 240 each, USD 1,440 total; tax USD 0 and delivery USD 0 (demo assumptions)." },
      leadTimeDays: 21, restockingFeeBps: 1_500,
      returnPolicy: "Fictional terms: an order not yet confirmed can be changed, including its quantity, or cancelled free of charge. Unused lights may be returned within 14 days of delivery with prior approval, with a 15% restocking fee on the goods price. These pendants have not been ordered.",
    }),
    product({
      itemId: "stools", name: "Counter stool", vendor: "Ridge Seating (demo)", sku: "DEMO-CAFE-STOOL-26",
      specification: "26 in counter-height stool, oak seat on a black steel frame, with footrest",
      quantity: 8, unitLabel: "each", unitPriceCents: 19_500,
      source: { kind: "demo", reference: "MAPLE-CAFE-STOOL-01", name: "Fictional Ridge Seating stool quote",
        note: "Local fictional per-stool price and order terms; the quantity is a count of stools.", priceNote: "Eight stools at USD 195 each, USD 1,560 total; tax USD 0 and delivery USD 0 (demo assumptions)." },
      leadTimeDays: 21, restockingFeeBps: 1_500,
      returnPolicy: "Fictional terms: an order not yet confirmed can be changed, including its quantity, or cancelled free of charge. Unused stools may be returned within 14 days of delivery with prior approval, with a 15% restocking fee on the goods price. These stools have not been ordered.",
    }),
  ],
};

/** Local fictional material supplied to the AI; none of these references is a real file or vendor quote. */
export const HOME_SUPPLIER_NOTES = `FICTIONAL MAPLE AVE CAFÉ SUPPLIER MATERIALS
Invented for this demo: not real suppliers, uploaded files or live stock checks. Prices are in USD and include tax and delivery. Lead times and terms are illustrative.

[MAPLE-CAFE-QUARTZ-01] Stoneline Fabrication (demo) · Quartz countertop
Current item: DEMO-CAFE-QUARTZ-30, 3 cm honed white quartz, 25 in deep, fabricated and installed; USD 180 per linear foot. The front counter and back bar tops were templated and cut to the agreed lengths; payment was due at templating.
Changes after cutting: a cut top can be re-cut to a shorter length for a fixed re-cut fee of USD 280 per top. The removed length is credited at USD 180 per linear foot, issued once the re-cut top is approved. A cut top cannot be lengthened or returned.

[MAPLE-CAFE-TILE-01] Glaze & Co. Tile (demo) · Wall tile
Current item: DEMO-CAFE-TILE-WHT-4, 4 × 4 in ceramic tile, white gloss glaze; one box covers 10 sq ft; USD 70 per box. The boxes for the back bar wall have been delivered and are unopened.
Alternative: DEMO-CAFE-TILE-SGE-4, the same 4 × 4 in tile in a sage green glaze; one box covers 10 sq ft; USD 76 per box; lead time 10 days.
Terms: unopened boxes can be returned within 30 days of delivery with prior approval. We keep 20% of the returned goods price as a restocking fee and credit the rest once the boxes are collected.

[MAPLE-CAFE-PENDANT-01] Lumen Row Lighting (demo) · Pendant lights
Current item: DEMO-CAFE-PENDANT-9, 9 in opal glass pendant, brushed brass, dimmable; USD 240 each; lead time 21 days.
Terms: an order not yet confirmed can be changed, including its quantity, or cancelled free of charge. Unused lights can be returned within 14 days of delivery with prior approval; a 15% restocking fee applies to the goods price.

[MAPLE-CAFE-STOOL-01] Ridge Seating (demo) · Counter stools
Current item: DEMO-CAFE-STOOL-26, 26 in counter-height stool, oak seat on a black steel frame, with footrest; USD 195 each; lead time 21 days.
Terms: an order not yet confirmed can be changed, including its quantity, or cancelled free of charge. Unused stools can be returned within 14 days of delivery with prior approval; a 15% restocking fee applies to the goods price.

[MAPLE-CAFE-JOINERY-01] Birch Line Joinery (demo) · Window counter
Item: DEMO-CAFE-OAK-WIN-36, solid oak window counter, 16 in deep, oiled, on black steel brackets, built for a 36 in counter height; made to measure; USD 210 per linear foot; lead time 21 days.
Terms: made to order. Once production starts, a counter cannot be cancelled or returned.

[MAPLE-CAFE-ACOUSTIC-01] Quiet Panel Co. (demo) · Acoustic panels
Item: DEMO-CAFE-FELT-24, 2 × 4 ft ceiling-hung felt acoustic panel, charcoal; USD 145 each; lead time 14 days.
Terms: unused panels can be returned within 14 days of delivery with prior approval; a 10% restocking fee applies to the goods price.

[MAPLE-CAFE-SERVICE-01] Lee Studio (demo) · Design services
Service: DEMO-CAFE-DESIGN-01, concept, counter and back-bar layout, and construction drawings; fixed fee USD 2,400.

[MAPLE-CAFE-SERVICE-02] Lee Studio (demo) · Site visits
Service: DEMO-CAFE-VISIT, one site visit of up to two hours during installation, with written notes for the installers; USD 180 per visit.`;

/** Conversation stops at agreement on direction; there is no AI message or priced client approval. */
export const HOME_DISCUSSION: readonly { actor: "client" | "designer"; text: string }[] = [
  { actor: "client", text: "Good news: the landlord has agreed we can use the front window bay as well. I'd love a counter along the window where people can sit and look out. Could we fit that in before the installers start?" },
  { actor: "designer", text: "That's a great use of the window. The bay is about 16 feet wide, so a 16-foot solid oak counter along the glass would work. I'd keep it at the same height as the main counter so the same stools fit. How many extra seats would you like there?" },
  { actor: "client", text: "Six along the window, I think. So we'd have fourteen stools in total." },
  { actor: "designer", text: "Six fits comfortably along 16 feet. More people and more hard surfaces will also make the room louder, so I'd suggest felt acoustic panels hung from the ceiling over the seating." },
  { actor: "client", text: "Yes please, the noise already worries me at the weekend. How many would we need?" },
  { actor: "designer", text: "For a room this size, twelve of the 2 by 4 foot panels in charcoal would take the edge off without looking busy." },
  { actor: "client", text: "Twelve sounds right. Let's do it." },
  { actor: "designer", text: "To reach the window counter, the queue needs a clear route past the front counter. I'd shorten the front counter from 14 to 10 feet. The tops have already been cut, so the fabricator would re-cut that one; the back bar stays at 8 feet." },
  { actor: "client", text: "Ten feet is still enough for the till and the pastry case. Go ahead with the re-cut." },
  { actor: "designer", text: "With a shorter front counter, six pendants would crowd it. Four would space out evenly over the 10 feet." },
  { actor: "client", text: "Four then. I'd rather they look deliberate than squeezed in." },
  { actor: "client", text: "One more thing. I looked at the tile samples again in daylight and the white feels a bit clinical. Is there a warmer colour in the same tile?" },
  { actor: "designer", text: "The same 4 inch tile comes in a sage green glaze. It would pick up the plants and the oak. The white boxes were delivered but they're still unopened, so we can send them back." },
  { actor: "client", text: "Sage green, please. And could the tile wrap around the corner onto the side wall too? That wall is about 60 square feet." },
  { actor: "designer", text: "Yes. With the back bar wall that makes 180 square feet, and I'd allow 10% for cuts as before." },
  { actor: "client", text: "Perfect." },
  { actor: "designer", text: "All of this adds installation work: the window counter, the panels and the tile on the side wall. I'd need two more site visits to check the installers' work, so six instead of four. The design fee itself stays as agreed." },
  { actor: "client", text: "That makes sense. Six visits." },
  { actor: "designer", text: "So the direction is: a 16-foot oak window counter, six more stools, twelve acoustic panels, the front counter re-cut to 10 feet, four pendants, sage green tile on the back bar and the side wall instead of the white, and two more site visits." },
  { actor: "client", text: "Just to check: the back bar top stays exactly as it is, and the green tile replaces the white rather than adding to it?" },
  { actor: "designer", text: "Exactly. The back bar top is unchanged, and the green tile replaces the white boxes we're sending back. The design fee is unchanged too." },
  { actor: "client", text: "Great, send me the revised quote when it's ready. I'll check it before confirming." },
];

export const HOME_DESIGNER_REQUEST = "@Setti Prepare the revised quote from our discussion.";
