import type { ApprovedQuoteLine, ApprovedQuoteReport, QuoteLineApproval } from "@/quotes/types";

/** Scenario revision, independent of the client's quote version. */
export const HOME_LEGACY_SCENARIO = "maple-living-dining-v2" as const;
export const HOME_SCENARIO = "maple-living-dining-v3" as const;
export const HOME_SCENARIO_VERSION = 3;
export function isHomeScenario(value: string | undefined): boolean {
  return value === HOME_SCENARIO || value === HOME_LEGACY_SCENARIO;
}
export const HOME_ITEM_IDS = ["sofa", "coffee-table", "dining-table", "dining-chairs", "sideboard"] as const;

const approvedAt = "2026-10-03T15:00:00-07:00";
const room = "Living & dining room";
const approval: QuoteLineApproval = {
  status: "approved", approvedBy: "Emma Park", approvedAt,
  signature: "Emma Park (demo signature)", isDemo: true,
};

function furniture(line: Omit<ApprovedQuoteLine, "category" | "room" | "taxCents" | "freightCents" | "approval" | "customMade" | "nonReturnable" | "unitLabel">): ApprovedQuoteLine {
  return { ...line, category: "furniture", room, taxCents: 0, freightCents: 0,
    unitLabel: "each", customMade: false, nonReturnable: false, approval: { ...approval } };
}

/** Fictional agreed baseline. It contains no PayPal resource IDs or payment-state claims. */
export const HOME_APPROVED_QUOTE: ApprovedQuoteReport = {
  id: "demo-maple-living-dining-v1", version: 1, projectId: "maple", projectName: "Maple Ave", room,
  clientName: "Emma Park", designerName: "Jordan Lee", currency: "USD", status: "approved",
  approvedAt, approvedBy: "Emma Park", signature: "Emma Park (demo signature)", isDemo: true,
  demoNotice: "Fictional Maple living-and-dining example. Clients, suppliers, products, source references, dates, terms and signatures are demonstration data; no source reference identifies a real supplier document.",
  paymentNote: "Agreed prices only. Approval does not confirm that any PayPal hold, charge or refund exists; consult the saved payment records.",
  assumptions: [
    "All prices are USD. Every line has USD 0 tax and USD 0 delivery as explicit demo assumptions, not a tax calculation or a supplier promise of free delivery.",
    "Each supplier reference identifies fictional local scenario material, not an uploaded or externally verified document. Dimensions, lead times and return terms are illustrative.",
    "The fixed USD 1,000 design-service scope and fee remain unchanged in the requested furniture revision.",
    "The example approval date and typed signature do not represent a real client's signature.",
  ],
  lines: [
    {
      itemId: "design", name: "Design services", vendor: "Lee Studio (demo)", category: "service", room,
      sku: "DEMO-LD-DESIGN-01", specification: "Living-and-dining layout and furniture selection; fixed scope and fee",
      quantity: 1, unitLabel: "fixed fee", unitPriceCents: 100_000, taxCents: 0, freightCents: 0,
      source: { kind: "demo", reference: "MAPLE-LD-SERVICE-01", name: "Fictional studio service agreement",
        note: "Local fictional scenario terms; not an uploaded or supplier-issued agreement.", priceNote: "One fixed fee of USD 1,000; unchanged in this revision." },
      leadTimeDays: null, returnPolicy: "Fictional service terms: this furniture revision leaves the agreed service scope and USD 1,000 fee unchanged; any service cancellation needs a separate review.",
      restockingFeeBps: 0, customMade: false, nonReturnable: false, approval: { ...approval },
    },
    furniture({
      itemId: "sofa", name: "Three-seat sofa", vendor: "Alder Room (demo)", sku: "DEMO-LD-SOFA-230",
      specification: "Straight sofa, warm neutral fabric; 230 cm W × 95 cm D × 80 cm H; no chaise",
      quantity: 1, unitPriceCents: 240_000,
      source: { kind: "demo", reference: "MAPLE-LD-SOFA-01", name: "Fictional Alder Room sofa quote",
        note: "Local fictional sofa price, dimensions and cancellation/return terms.", priceNote: "One 230 cm sofa at USD 2,400; tax USD 0 and delivery USD 0 (demo assumptions)." },
      leadTimeDays: 21, restockingFeeBps: 1_500,
      returnPolicy: "Fictional terms: before supplier order confirmation, cancel at no retained cost. After delivery, an unused standard sofa may be returned with prior approval within 14 days, retaining 15% of the goods price. No sofa has been ordered in this scenario's starting history.",
    }),
    furniture({
      itemId: "coffee-table", name: "Large rectangular coffee table", vendor: "Orbit Workshop (demo)", sku: "DEMO-LD-COFFEE-120",
      specification: "Light oak rectangular coffee table; 120 cm W × 65 cm D × 40 cm H",
      quantity: 1, unitPriceCents: 65_000,
      source: { kind: "demo", reference: "MAPLE-LD-COFFEE-01", name: "Fictional Orbit Workshop table quote",
        note: "Local fictional coffee-table and mobile-side-table alternatives with their own terms.", priceNote: "One large coffee table at USD 650; tax USD 0 and delivery USD 0 (demo assumptions)." },
      leadTimeDays: 14, restockingFeeBps: 1_000,
      returnPolicy: "Fictional terms: cancel before supplier confirmation at no retained cost. Unused standard tables can be returned within 14 days with prior approval, retaining 10% of the goods price. The original coffee table has not been ordered.",
    }),
    furniture({
      itemId: "dining-table", name: "Fixed six-person dining table", vendor: "Common Table Co (demo)", sku: "DEMO-LD-DINING-160",
      specification: "Fixed rectangular dining table, light oak; 160 cm W × 85 cm D × 75 cm H; seats six; no extension",
      quantity: 1, unitPriceCents: 140_000,
      source: { kind: "demo", reference: "MAPLE-LD-DINING-01", name: "Fictional Common Table dining-table quote",
        note: "Local fictional rectangular and round dining-table specifications and supplier terms.", priceNote: "One six-person rectangular table at USD 1,400; tax USD 0 and delivery USD 0 (demo assumptions)." },
      leadTimeDays: 21, restockingFeeBps: 1_500,
      returnPolicy: "Fictional terms: cancel before supplier confirmation at no retained cost. An unused standard table may be returned within 14 days with prior approval, retaining 15% of the goods price. The original dining table has not been ordered.",
    }),
    furniture({
      itemId: "dining-chairs", name: "Upholstered dining chairs", vendor: "Gather Seating (demo)", sku: "DEMO-LD-CHAIR-01",
      specification: "Matching light oak frame, warm neutral upholstery; 45 cm W × 53 cm D × 80 cm H; seat height 46 cm",
      quantity: 6, unitPriceCents: 18_000,
      source: { kind: "demo", reference: "MAPLE-LD-CHAIRS-01", name: "Fictional Gather Seating chair quote",
        note: "Local fictional per-chair quote and quantity-reduction terms; the quantity is a count of individual chairs.", priceNote: "Six chairs at USD 180 each, USD 1,080 total; tax USD 0 and delivery USD 0 (demo assumptions)." },
      leadTimeDays: 14, restockingFeeBps: 1_000,
      returnPolicy: "Fictional terms: reduce the quantity before supplier confirmation at no retained cost. After delivery, unused chairs may be returned with prior approval within 14 days, retaining 10% of the returned goods price. These chairs have not been ordered.",
    }),
    furniture({
      itemId: "sideboard", name: "Dining sideboard", vendor: "Still House Storage (demo)", sku: "DEMO-LD-SIDEBOARD-160",
      specification: "Standard light oak sideboard; 160 cm W × 40 cm D × 80 cm H",
      quantity: 1, unitPriceCents: 120_000,
      source: { kind: "demo", reference: "MAPLE-LD-SIDEBOARD-01", name: "Fictional Still House return terms",
        note: "Local fictional sideboard quote and return-credit terms; not a real supplier credit.", priceNote: "One sideboard at USD 1,200; tax USD 0 and delivery USD 0 (demo assumptions)." },
      leadTimeDays: 21, restockingFeeBps: 2_000,
      returnPolicy: "Fictional terms: return the unused standard sideboard within 14 days of delivery with prior supplier approval, retaining 20% of the goods price. For this USD 1,200 line the inclusive retained cost is USD 240 and the supplier credit is USD 960; there is no additional cancellation charge, and a customer refund waits for that credit. Do not assume payment or credit occurred from this quote alone.",
    }),
  ],
};

/** Local fictional material supplied to the AI; none of these references is a real file or vendor quote. */
export const HOME_SUPPLIER_NOTES = `FICTIONAL MAPLE LIVING & DINING SUPPLIER MATERIALS
These are Setti's invented demonstration inputs, not real supplier documents, uploaded files, live stock checks or external product recommendations. All amounts are USD. Line tax and delivery are explicitly USD 0 for both original and proposed goods, solely as demo assumptions. No alternative is custom-made. Lead times and return terms are illustrative. A quote or these notes do not prove a PayPal transaction or a supplier credit; use the saved ledger for payment facts. The designer must review and the client must formally confirm a priced change before any money action.

[MAPLE-LD-SOFA-01] itemId=sofa | Alder Room (demo)
Original: DEMO-LD-SOFA-230, one straight three-seat sofa, 230 × 95 × 80 cm (W × D × H), warm neutral fabric, no chaise; unit USD 2,400, line USD 2,400.
Alternative: DEMO-LD-SOFA-200, one compact straight sofa, 200 × 90 × 80 cm, warm neutral fabric, no chaise; unit USD 2,100, quantity 1, line USD 2,100; sample lead time 21 days. Do not retain the larger sofa as an additional item.
Handling and returns: original sofa not ordered; cancel before supplier confirmation with USD 0 retained cost. Standard unused sofas may be returned within 14 days of delivery with prior approval and a 15% goods-price restocking fee. This later-return fee does not apply to the unplaced original order.

[MAPLE-LD-COFFEE-01] itemId=coffee-table | Orbit Workshop (demo)
Original: DEMO-LD-COFFEE-120, one large rectangular coffee table, 120 × 65 × 40 cm; unit and line USD 650.
Alternative: DEMO-LD-SIDE-40, small movable round side table, 40 cm diameter × 50 cm high, light oak, easy to lift; unit USD 180, quantity 2, combined line USD 360; sample lead time 14 days. Two independent small tables replace the single large coffee table; this is neither a single USD 360 table nor two large coffee tables.
Handling and returns: original coffee table not ordered; cancel before supplier confirmation with USD 0 retained cost. Standard unused tables may be returned within 14 days with prior approval and a 10% goods-price restocking fee.

[MAPLE-LD-DINING-01] itemId=dining-table | Common Table Co (demo)
Original: DEMO-LD-DINING-160, one fixed rectangular table, 160 × 85 × 75 cm, seats six, no extension; unit and line USD 1,400.
Alternative: DEMO-LD-ROUND-110, one round light oak dining table, 110 cm diameter × 75 cm high, suitable for four people, fixed top, no extension; unit USD 1,250, quantity 1, line USD 1,250; sample lead time 21 days. Diameter is not rectangular width; do not invent a six-seat or extending table.
Handling and returns: original dining table not ordered; cancel before supplier confirmation with USD 0 retained cost. An unused standard table may be returned within 14 days with prior approval and a 15% goods-price restocking fee. Room circulation still needs the designer's measured-layout review; these dimensions are not a verified clearance plan.

[MAPLE-LD-CHAIRS-01] itemId=dining-chairs | Gather Seating (demo)
Keep DEMO-LD-CHAIR-01, the existing light oak chair with warm neutral upholstery, 45 × 53 × 80 cm, seat height 46 cm. Original quantity 6 × unit USD 180 = USD 1,080. Revised quantity 4 × unit USD 180 = USD 720, four chairs total, not four additional chairs; sample lead time 14 days.
Handling and returns: chairs not ordered; reducing from six to four before supplier confirmation has USD 0 retained cost. Later returns of unused chairs within 14 days require prior approval and retain 10% of the returned goods price. Keep this as a quantity change to the existing chair line.

[MAPLE-LD-SIDEBOARD-01] itemId=sideboard | Still House Storage (demo)
Original: DEMO-LD-SIDEBOARD-160, one standard light oak sideboard, 160 × 40 × 80 cm; unit and line USD 1,200; sample lead time 21 days. Remove it entirely, with no replacement cabinet and no zero-priced new product.
Fictional starting-history condition: the sideboard was an early delivery, supplier-confirmed and charged at USD 1,200; consult the actual prepared ledger to verify the payment state. It remains unused and within the sample 14-day return window. This supplier permits its return with prior approval and a 20% inclusive retained cost: USD 1,200 × 20% = USD 240. Old-item handling is returned, not not_ordered. Expected supplier credit and subsequent customer refund: USD 1,200 − USD 240 = USD 960. There are no additional tax, freight, handling or cancellation charges in this sample. The USD 240 is a retained cost on the removed line, not a new service. Record the supplier credit before refunding; do not claim the credit or refund already happened.

[MAPLE-LD-SERVICE-01] itemId=design | Lee Studio (demo)
DEMO-LD-DESIGN-01, living-and-dining layout and furniture selection, one fixed service fee of USD 1,000. The service scope, quantity and fee remain unchanged. Do not reprice or remove it as part of these five furniture changes. Product restocking terms do not apply to services; any service cancellation needs its own review.

These are separate supplier and studio source notes. Combine the products and quantities agreed in the discussion when preparing the revised proposal; no consolidated revised project total is supplied here. The original approved quote remains unchanged until the normal review and confirmation flow. Do not net different items' payment actions or execute a payment from this request.`;

/** Conversation stops at agreement on direction; there is no AI message or priced client approval. */
export const HOME_DISCUSSION: readonly { actor: "client" | "designer"; text: string }[] = [
  { actor: "client", text: "After measuring the living and dining room and marking out the furniture footprints, the layout feels crowded, especially on the route between the sofa and dining area. Could we make it feel lighter before we go any further?" },
  { actor: "designer", text: "Yes. Which pieces feel most in the way, and how many people actually use the room on an ordinary day? That will help us reduce the scale without losing what you need." },
  { actor: "client", text: "It's usually just the two of us, and we rarely have more than four people over. The 230 cm sofa footprint looks heavier than I expected in the mock-up. I'd like a more compact one, but still something comfortable to sit on." },
  { actor: "designer", text: "Would a straight sofa about 200 cm wide and 90 cm deep work for you? We can keep the warm neutral fabric and avoid a chaise so it doesn't reach into the walkway." },
  { actor: "client", text: "Yes, that sounds right: a compact straight sofa in the same warm neutral direction, with no chaise. I'd rather keep the route open than fill the wall." },
  { actor: "designer", text: "The large rectangular coffee table also occupies that central space. Do you need one continuous surface there, or would smaller tables you can move beside the seats suit your routine?" },
  { actor: "client", text: "Smaller movable ones would be better. Could we use two little side tables for drinks, one by each seat, and leave the middle open? I don't want another large coffee table." },
  { actor: "designer", text: "Let's use two separate light oak round side tables, around 40 cm in diameter and 50 cm high, light enough to lift. For dining, the current fixed rectangular table seats six. Would a round table suit your smaller group?" },
  { actor: "client", text: "I like the idea of a round table because it's easier to move around. What diameter would work for four people? I don't need it to extend for six." },
  { actor: "designer", text: "A 110 cm diameter round table is a sensible four-person option for this layout. I'd keep a fixed top and check its position and chair clearances against the measured plan before an order." },
  { actor: "client", text: "Let's go with 110 cm and four seats, fixed rather than extending. Please keep the light oak finish so it still feels connected to the living area." },
  { actor: "designer", text: "Shall we keep the dining chair style and upholstery you already chose, but reduce the number? Also, is the sideboard still useful, or is clearing that wall more valuable now?" },
  { actor: "client", text: "Keep those chairs but make it four instead of six. Let's cancel the sideboard completely. We can use storage in the hall, and I'd rather leave the dining wall clear." },
  { actor: "designer", text: "Understood: no smaller replacement cabinet either. The sideboard was the one piece delivered early, so I'll check its return terms before pricing this. The sofa, tables and dining chairs haven't been ordered; we've only been testing their positions in the layout." },
  { actor: "client", text: "Yes, remove it with no replacement. Please explain any return cost when you prepare the proposal. The design work you've agreed to do is still needed, so keep that service scope the same." },
  { actor: "designer", text: "The direction is one compact 200 × 90 cm sofa, two movable round side tables, one 110 cm round table for four, four of the existing dining chairs and no sideboard. I'll bring the supplier details together for the revised proposal and check it before sending it to you." },
  { actor: "client", text: "That matches what I have in mind. Just to be clear, the four chairs are the whole dining set, not four more on top of the six, and the two small tables take the place of the large coffee table." },
  { actor: "designer", text: "Exactly: four chairs in total and two small side tables instead of the single large coffee table. I'll keep the furniture changes together and leave design services unchanged." },
  { actor: "client", text: "Great, send me the revised quote when it's ready. I'll check it before confirming." },
];

export const HOME_DESIGNER_REQUEST = "@AI Prepare the revised quote from our discussion.";
