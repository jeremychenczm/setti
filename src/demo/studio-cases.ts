import type { StudioCase, StudioLine, StudioLineKind, StudioMoneyLine, StudioQuote } from "./studio-types";

const line = (id: string, name: string, kind: StudioLineKind, quantity: number, unit: string, unitPriceCents: number, specification: string): StudioLine => ({ id, name, kind, quantity, unit, unitPriceCents, specification, source: `Fictional supplier schedule · ${id.toUpperCase()}` });
const money = (lineId: string, values: Partial<Omit<StudioMoneyLine, "lineId">> = {}): StudioMoneyLine => ({ lineId, heldCents: 0, capturedCents: 0, refundedCents: 0, releasedCents: 0, awaitingCreditCents: 0, ...values });
const quote = (version: number, status: StudioQuote["status"], lines: StudioLine[], note: string): StudioQuote => ({ version, status, lines, note });

/** Four messages per day: a conversation revisited over several days, not a single perfect instruction. */
function conversation(start: string, texts: string[], extraDayBefore: number[] = []) {
  const base = Date.parse(`${start}T09:10:00-07:00`);
  return texts.map((text, index) => ({ actor: index % 2 === 0 ? "client" as const : "designer" as const, text, at: new Date(base + (Math.floor(index / 4) + extraDayBefore.filter((boundary) => index >= boundary).length) * 86_400_000 + index % 4 * 12 * 60_000).toISOString() }));
}

const bistroV1 = [
  line("bistro-design", "Interior layout & finish selection", "Design service", 1, "service", 180_000, "Dining-room layout, material schedule and two site visits. Design fee paid under V1."),
  line("bistro-floor", "Dining-room floor tile", "Material", 480, "sq ft", 750, "Original light concrete-look tile; material supply only."),
  line("bistro-oak", "Oak wall lining", "Material", 160, "sq ft", 1250, "Oak-veneered panels to the full rear wall."),
  line("bistro-delivery", "Materials delivery", "Delivery", 1, "delivery", 16_000, "One consolidated supplier delivery; installation excluded."),
];
const bistroV2 = [bistroV1[0],
  line("bistro-floor", "Warm porcelain floor tile", "Material", 528, "sq ft", 875, "480 sq ft measured floor plus 10% cutting allowance. Wet-use suitability to follow the supplier's product sheet and installer review."),
  line("bistro-oak", "Oak wall lining", "Material", 128, "sq ft", 1250, "Shortened to the banquette wall; service-door zone left painted."),
  line("bistro-acoustic", "Fabric acoustic wall panels", "Material", 8, "panel", 7200, "600 × 1200 mm warm-grey panels above the banquette; fixing method to be checked on site."),
  line("bistro-delivery", "Materials delivery", "Delivery", 1, "delivery", 20_000, "Revised delivery includes the separate acoustic-panel supplier."),
];

const coffeeLines = [
  line("coffee-design", "Coffee bar layout & material schedule", "Design service", 1, "service", 150_000, "Counter layout, queue review and finish selection. Paid under V1."),
  line("coffee-counter", "Solid-surface counter sheets", "Material", 2, "sheet", 84_000, "Warm-white solid surface; fabricator to confirm seam, sink cut-out and final template before cutting."),
  line("coffee-tile", "Bar backsplash tile", "Material", 180, "sq ft", 900, "Small-format glazed tile, including the agreed cutting allowance; muted green sample approved."),
  line("coffee-pendant", "Opal counter pendants", "Furniture", 6, "light", 9500, "Replaceable lamp, brushed nickel fitting; electrician to confirm position and compatibility."),
  line("coffee-delivery", "Combined delivery", "Delivery", 1, "delivery", 12_000, "Booked delivery allowance; installation is under the contractor's separate agreement."),
];

const retailLines = [
  line("retail-design", "Retail layout & fixture selection", "Design service", 1, "service", 160_000, "Freestanding display layout and finish schedule. Paid under V1."),
  line("retail-paint", "Washable mineral-look wall paint", "Material", 12, "can", 6500, "Soft off-white; quantities include the supplier's specified primer/topcoat coverage."),
  line("retail-return", "Returned display panels · retained cost", "Retained cost", 1, "return", 39_000, "Original panels cost $2,600. Agreed 15% handling cost is $390. The $2,210 refund waits for matching supplier credit."),
  line("retail-shelf", "Freestanding modular shelves", "Furniture", 4, "unit", 29_500, "Black steel and birch; no new wall fixings. Assembly and site checks by the contractor."),
  line("retail-delivery", "Delivery & collection booking", "Delivery", 1, "booking", 14_000, "The shelf delivery charge; the returned-panel handling cost is separate above."),
];

const flatLines = [
  line("flat-design", "Apartment finish review", "Design service", 1, "service", 110_000, "Flooring selection, material coordination and installer handover. Paid under V1."),
  line("flat-floor", "Natural oak-look flooring", "Material", 32, "box", 6800, "Replacement finish, quoted per full box; installer checked coverage and the extra cutting allowance."),
  line("flat-underlay", "Compatible underlay", "Material", 18, "pack", 2400, "Supplier-matched underlay for the agreed flooring system."),
  line("flat-return", "Original flooring · retained return cost", "Retained cost", 1, "return", 21_600, "Original order $2,160. One opened box retained at $72 plus $144 collection; $1,944 refunded after supplier credit."),
  line("flat-delivery", "Replacement flooring delivery", "Delivery", 1, "delivery", 16_000, "Replacement delivery only; original collection is included in the return cost."),
];

const officeLines = [
  line("office-design", "Office layout & finishes", "Design service", 1, "service", 90_000, "Meeting-area and desk layout. Paid under V1."),
  line("office-carpet", "Stock acoustic carpet tile", "Material", 72, "tile", 1200, "Stock grey, 500 × 500 mm; installer confirmed the pack and cutting quantities."),
  line("office-glass", "Meeting-room glass panels", "Material", 4, "panel", 31_500, "Previously approved clear glass; supply only, landlord's agreed fixing detail unchanged."),
  line("office-paint", "Low-sheen wall paint", "Material", 5, "can", 5800, "Warm white, already delivered under V1."),
];

const salonLines = [
  line("salon-design", "Salon layout & finish proposal", "Design service", 1, "service", 95_000, "Draft fee for layout and material selection. Not yet approved or paid."),
  line("salon-paint", "Washable wall finish", "Material", 6, "can", 6800, "Provisional coverage; sample cleanability and colour still to be reviewed."),
  line("salon-floor", "Commercial vinyl planks", "Material", 24, "box", 7400, "Provisional full-box allowance. Subfloor preparation and wet-zone suitability need installer review."),
  line("salon-worktop", "Colour-station worktop sheets", "Material", 3, "sheet", 23_000, "Provisional compact laminate finish; chemical-resistance data and edge details still required."),
  line("salon-delivery", "Provisional delivery", "Delivery", 1, "delivery", 18_000, "Materials only. Plumbing, electrical and installation quotes are not included."),
];

/** No PayPal IDs, model outputs, signatures or executable operations are fabricated here. */
export const STUDIO_CASES: StudioCase[] = [
  {
    id: "alder-bistro", name: "Alder Bistro", industry: "Restaurant", location: "Neighbourhood bistro · dining-room refurbishment",
    client: { name: "Alex Rivera", title: "Owner & chef" }, stage: "awaiting_client", focus: ["Floor tile", "Wall lining", "Acoustics"],
    summary: "A warmer dining room that still works through a busy, wet evening service.",
    quote: quote(1, "approved", bistroV1, "Original approved dining-room scope. Only the design fee has been paid; materials have not been ordered."),
    proposal: quote(2, "awaiting_client", bistroV2, "Alex and Sam are reviewing this revision. Do not order the revised materials before formal approval. Supplier prices include zero line tax in this fictional example; labour is excluded."),
    messages: conversation("2026-10-25", [
      "We put the tile sample by the front door last night. It looks colder than it did in your studio.",
      "Was that under the new pendants or the existing ceiling lights? The colour shifts quite a bit between the two.",
      "Existing lights for now. Also, when it rained the floor by the door stayed wet for ages. I don't want to pick on colour alone.",
      "Agreed. I'll bring a warmer porcelain option and get the supplier's use data for the installer to review. Let's look at it beside the actual entrance mat.",
      "The warmer one feels right. The builder measured 480 square feet. Does that mean we just buy 480?",
      "Not quite. There are cuts around the banquette and doorway, and the supplier sells full packs. I'll have the take-off and pack allowance shown separately in the quote.",
      "One other thing: during the soft opening we could barely hear each other along the back wall.",
      "We can put acoustic panels above the banquette. I'd shorten the oak lining rather than add another finish across the whole room.",
      "Yes, leave the area by the service door painted. It gets knocked by the trolley anyway.",
      "That keeps the oak where guests see it and gives us a place for the panels. I'll check the fixing detail with the builder before anything is ordered.",
      "Can you keep the floor, shorter oak wall and acoustic panels on one revision? Sam needs to see the whole change together.",
      "Of course. The design fee stays as agreed. I'll show the materials and delivery separately so neither of you has to piece the numbers together from messages.",
      "Send it over. I'll go through it with Sam after lunch. Please hold off ordering until we've both looked.",
      "V2 is there for you to review. Nothing from the revised materials list has been ordered or charged.",
    ]),
    money: bistroV1.map((entry) => money(entry.id, entry.kind === "Design service" ? { capturedCents: 180_000 } : {})),
    timeline: [
      { date: "23 Oct", title: "V1 approved", text: "Dining-room scope agreed; the design service paid separately." },
      { date: "25–28 Oct", title: "Materials discussed on site", text: "Entrance tile, banquette wall and acoustic treatment reviewed together." },
      { date: "28 Oct", title: "V2 sent", text: "The revised quote awaits Alex's formal confirmation. V1 remains the approved scope." },
    ],
    next: { actor: "Alex · client", title: "Review the revised quote", detail: "Compare V2 with V1 and confirm or request changes. No revised material purchase starts before approval." },
  },
  {
    id: "juniper-coffee", name: "Juniper Coffee", industry: "Coffee shop", location: "Small corner café · counter and back bar",
    client: { name: "Maya Chen", title: "Café owner" }, stage: "awaiting_supplier", focus: ["Countertop", "Backsplash tile", "Lighting"],
    summary: "Keep the queue moving without leaving an awkward seam beside the espresso machine.",
    quote: quote(2, "approved", coffeeLines, "V2 approved. Design and delivery are paid; three goods lines are held. Cutting, stock and lead time still need supplier confirmation. All example line tax is explicitly zero."),
    messages: conversation("2026-10-25", [
      "We taped the counter onto the floor. The queue runs straight into the pastry display.",
      "Can the display move towards the window, or does that block the collection end?",
      "Towards the window works. The barista still needs a clear bit beside the machine for milk and cups.",
      "Then I'll shift the collection point rather than make the whole counter deeper. We should ask the fabricator where the joint would land.",
      "They drew a joint right next to the sink. That's the bit I'm worried about cleaning.",
      "I'll ask for the template and a revised joint position. The solid-surface sheet option gives us a different layout, but it still needs their sign-off before cutting.",
      "Let's use the warmer white sample. The bright white looked a bit like a clinic under our lights.",
      "Noted. Are you keeping the green backsplash? We can adjust the grout sample beside the warmer counter.",
      "Keep the green. Maybe a quieter grout line. And six pendants is enough, right? The extra two felt busy.",
      "Six follows the counter layout. The electrician still needs to check the exact positions; I won't assume a drawing is a site measurement.",
      "I signed V2 and approved the holds. Does that mean the countertop is already being cut?",
      "No. The amount is reserved, but the counter supplier hasn't confirmed the final template, stock and delivery date. We wait for that before charging the goods.",
      "Good. Please don't rush the cut-out just to make the opening date. I'd rather move the coffee machine for a few days.",
      "I've sent that with the template request. The order stays at supplier confirmation until we have their reply.",
    ]),
    money: coffeeLines.map((entry) => money(entry.id, entry.kind === "Design service" || entry.kind === "Delivery" ? { capturedCents: entry.quantity * entry.unitPriceCents } : { heldCents: entry.quantity * entry.unitPriceCents })),
    timeline: [
      { date: "23 Oct", title: "V1 design service paid", text: "The original design fee remains paid and is carried into the revision." },
      { date: "27 Oct", title: "V2 approved and funded", text: "Counter sheets, backsplash tile and pendants each have a prepared hold record." },
      { date: "29 Oct", title: "Fabricator response pending", text: "Final template, stock, price and lead time still need confirmation before goods are charged." },
    ],
    next: { actor: "Jordan · designer", title: "Get the supplier confirmations", detail: "Check the counter template and each supplier's exact quantity, price and delivery terms. An approved quote and a hold do not confirm a supplier order." },
  },
  {
    id: "fieldwork-goods", name: "Fieldwork Goods", industry: "Retail", location: "Independent homeware shop · display refresh",
    client: { name: "Asha Patel", title: "Shop founder" }, stage: "awaiting_credit", focus: ["Display panels", "Wall finish", "Modular shelving"],
    summary: "Swap fixed display panels for movable shelves, with the return cost kept visible.",
    quote: quote(2, "approved", retailLines, "The agreed panel return retains $390. Supplier credit of $2,210 is still pending; no refund is recorded yet. Shelf holds remain open. Example line tax is zero."),
    messages: conversation("2026-10-24", [
      "The display-panel crates are here. We stood a sample against the back wall and the shop suddenly felt much smaller.",
      "Is it the colour or the depth? We can move the sample before deciding what to change.",
      "Mostly the depth. We're adding workshops next month, so I need to move the displays out of the way.",
      "Then freestanding modules make more sense than panels fixed across that wall. Have any of the supplied panels been cut or fitted?",
      "No. The installer only opened the packing enough to check one. Everything is still in the crates.",
      "I'll check the return terms with the supplier first. We've already paid for these panels, so changing the design doesn't automatically put the money back.",
      "Okay. Please don't hide a return fee inside the new shelf price. I need to explain it to my business partner.",
      "It will be its own retained-cost line. The new shelves will be a separate purchase, so you can see exactly what we keep and what should come back.",
      "Four movable units will do. Can we keep the warmer wall finish from the last sample?",
      "Yes. The wall paint stays, and I can keep the existing lighting. No need to replace things that are working.",
      "I've signed the revised quote. The courier collected the crates this morning—what do we need before the refund can happen?",
      "Not yet. Collection is recorded, but the supplier hasn't issued the credit after its warehouse check. The agreed refund stays pending until that credit arrives.",
      "Understood. Let me know if they say anything is damaged. I took photos before the courier loaded them.",
      "Keep those photos with the collection note. I'll match the supplier's credit to the agreed return before the refund is released.",
    ]),
    money: [money("retail-design", { capturedCents: 160_000 }), money("retail-paint", { capturedCents: 78_000 }), money("retail-return", { capturedCents: 260_000, awaitingCreditCents: 221_000 }), money("retail-shelf", { heldCents: 118_000 }), money("retail-delivery", { capturedCents: 14_000 })],
    timeline: [
      { date: "22 Oct", title: "Original panels paid", text: "The original $2,600 panel purchase is part of the prepared history." },
      { date: "26 Oct", title: "V2 approved", text: "Four modular shelves replace the panels; the client agreed to the separately stated $390 retained cost." },
      { date: "26 Oct", title: "Panels collected", text: "Collection note saved. Warehouse inspection and supplier credit remain pending." },
    ],
    next: { actor: "Jordan · designer", title: "Match the supplier return credit", detail: "The target refund is $2,210. Collection alone is insufficient; wait for the matching credit before executing it. Confirm the new shelves separately." },
  },
  {
    id: "harbor-flat", name: "Harbor Flat", industry: "Residential", location: "Two-bedroom apartment · flooring and finishes",
    client: { name: "Nina Brooks", title: "Homeowner" }, stage: "settled", focus: ["Flooring", "Underlay", "Partial refund"],
    summary: "A flooring finish changed after delivery, with the opened box and collection accounted for.",
    quote: quote(2, "approved", flatLines, "Replacement flooring and underlay paid. Supplier credit matched and $1,944 refunded; $216 remains as agreed. No open holds. These figures exclude separately contracted installation and use zero line tax."),
    messages: conversation("2026-10-24", [
      "We laid a few boards by the balcony this morning. They look much pinker than the small sample.",
      "Could you send a photo in daylight with a piece of the wall paint beside them? Let's compare the batch label as well.",
      "The labels match. I think it's just the light in this room. We've only opened one box; nothing is installed.",
      "That's useful. Please leave the other boxes sealed while I check the return and bring the more neutral option.",
      "The second sample is much better. Will we need the same number of boxes?",
      "Not necessarily—the coverage per box is different. I'll ask the installer to recheck the take-off and the supplier to quote full boxes, including the cuts.",
      "Can we use the underlay already on site? It would be nice not to change everything.",
      "Only if it's compatible with the replacement flooring system. I'll have that checked rather than assume the two products use the same underlay.",
      "The new underlay is fine. What happens to the box we opened?",
      "That box stays with you. The return schedule also includes collection. I'll show both in the revision instead of calling the entire old order refundable.",
      "I've checked and signed V2. Please go ahead with the return and the replacement order.",
      "The supplier has now confirmed the returned boxes and issued the credit. The matching refund is recorded, and the replacement materials are paid.",
      "I can see the refund entry. So the opened box and collection are the only parts of the old order we're keeping?",
      "Yes. They're the retained return-cost line. The replacement flooring, compatible underlay and delivery are listed separately in the final quote.",
    ], [11]),
    money: [money("flat-design", { capturedCents: 110_000 }), money("flat-floor", { capturedCents: 217_600 }), money("flat-underlay", { capturedCents: 43_200 }), money("flat-return", { capturedCents: 216_000, refundedCents: 194_400 }), money("flat-delivery", { capturedCents: 16_000 })],
    timeline: [
      { date: "23 Oct", title: "Original flooring paid", text: "$2,160 paid for the first finish; only one box subsequently opened." },
      { date: "26 Oct", title: "V2 approved", text: "Replacement quantities and compatible underlay agreed; $216 return cost retained." },
      { date: "27 Oct", title: "Return credit matched", text: "$1,944 refunded after supplier credit. Replacement flooring, underlay and delivery paid; no hold remains." },
    ],
    next: { actor: "Nina · client", title: "Review the completed adjustment", detail: "The example's net payment is $4,084, matching V2. The original return and the new purchase remain separate in the payment history." },
  },
  {
    id: "northline-office", name: "Northline Office", industry: "Office", location: "Small creative studio · meeting corner",
    client: { name: "Leo Morgan", title: "Studio co-founder" }, stage: "declined", focus: ["Carpet tile", "Glass partition", "Privacy film"],
    summary: "A more private meeting corner was proposed, then postponed to stay within the approved budget.",
    quote: quote(1, "approved", officeLines, "V1 remains the approved scope. The design fee and paint are paid; the carpet and glass have open holds. The declined V2 creates no new payment authority. Example line tax is zero; installation is separate."),
    proposal: quote(2, "declined", [officeLines[0], line("office-carpet", "Upgraded acoustic carpet tile", "Material", 72, "tile", 1300, "Thicker-backed option proposed for the meeting area."), officeLines[2], officeLines[3], line("office-film", "Frosted meeting-room film", "Material", 4, "panel", 9500, "Optional privacy film to the four previously agreed glass panels.")], "Leo declined the additional scope. Keep V1 and do not authorize or order the V2 additions."),
    messages: conversation("2026-10-25", [
      "We had two calls in the meeting corner yesterday. People walking past can read the screens through the glass.",
      "Would a frosted band at seated eye level solve that, rather than frosting the full height?",
      "Probably. I'd still like daylight to come through. Also, the carpet sample felt thinner than I expected.",
      "I can price the thicker-backed option alongside the stock tile. We should compare them under the actual chairs before changing the order.",
      "The thicker one feels nicer. Can you include the film and the carpet change in the same revision?",
      "Yes. The glass panels and wall paint themselves stay as approved. I'll keep those separate from the optional upgrades.",
      "One concern: we've just had the network-installation bill. The fit-out budget is tighter than last week.",
      "Then treat this as an option to review, not an instruction to purchase. Nothing additional will be ordered just because I send the revised sheet.",
      "I've looked at V2 with my co-founder. We're going to stick with the original carpet and leave the film until next quarter.",
      "Understood. Please decline V2 on the quote so the record matches this decision. V1 will remain the approved version.",
      "Done. The original paint can still go ahead, and we'd like to keep the glass delivery slot.",
      "Both remain under V1. I'll continue checking those supplier confirmations; I won't turn the rejected upgrade into a payment request.",
    ]),
    money: [money("office-design", { capturedCents: 90_000 }), money("office-carpet", { heldCents: 86_400 }), money("office-glass", { heldCents: 126_000 }), money("office-paint", { capturedCents: 29_000 })],
    timeline: [
      { date: "23 Oct", title: "V1 approved and partly paid", text: "Design service and paint paid; original carpet and glass holds remain." },
      { date: "26 Oct", title: "Optional V2 sent", text: "Acoustic carpet upgrade and privacy film proposed together." },
      { date: "27 Oct", title: "V2 declined", text: "Budget decision recorded. V1 remains authoritative; no additional authorizations were created." },
    ],
    next: { actor: "Jordan · designer", title: "Continue the original approved scope", detail: "Keep V1's carpet and glass. Obtain the original suppliers' confirmations; the declined revision must not create new orders or holds." },
  },
  {
    id: "stillwater-salon", name: "Stillwater Salon", industry: "Salon", location: "Neighbourhood hair studio · colour stations",
    client: { name: "Rosa Ellis", title: "Salon owner" }, stage: "draft", focus: ["Wall coating", "Vinyl flooring", "Worktop sheets"],
    summary: "Practical finishes for a colour station, before the material schedule is ready to approve.",
    quote: quote(1, "draft", salonLines, "An unsent materials and design estimate. Measurements, product data, samples and supplier prices need review. Zero line tax is an explicit fictional assumption; plumbing, electrical work and installation are excluded."),
    messages: conversation("2026-10-26", [
      "The wall behind the colour station is covered in marks again. Whatever we use next needs to be easier to wipe down.",
      "Is it mainly dye splashes, or is the paint coming off when you clean it?",
      "Both. The team cleans it every night, and the finish has gone shiny in patches. I don't need it to look like a hotel; I need it to last.",
      "I'll compare sample finishes using the supplier's cleaning guidance. We should try the actual cleaning product on a sample before choosing one.",
      "Could we do the worktops at the same time? The joins around the mixing bowls trap colour.",
      "Yes. I'll look at sheet sizes and edge details, but I need the product's chemical-resistance data before recommending a surface for that station.",
      "And the floor? I'm not keen on lots of grout lines where hair collects.",
      "We can compare commercial vinyl options. The installer still needs to check the subfloor and the area by the basins, so I'll keep that as a draft allowance for now.",
      "Please keep the basins where they are. We can't close for a week to move plumbing.",
      "Then the layout will work around the existing plumbing. I'll make it clear that the material estimate doesn't include a plumber's or electrician's work.",
      "A weekend would be ideal, but let's see what the contractors say. I don't want the date driving us into the wrong finish.",
      "Agreed. I'll send the samples first, then finish the quote after the installer measures and the suppliers answer. Nothing needs approving or paying yet.",
    ]),
    money: salonLines.map((entry) => money(entry.id)),
    timeline: [
      { date: "26 Oct", title: "Brief opened", text: "Cleaning, joins and business downtime discussed before selecting products." },
      { date: "28 Oct", title: "Draft material allowances", text: "Wall finish, worktop sheets and vinyl listed provisionally; samples and product data outstanding." },
    ],
    next: { actor: "Jordan · designer", title: "Finish the material checks", detail: "Obtain samples, product data and the installer's measured quantities before sending V1. A draft allowance is not a supplier order or payment request." },
  },
];

export function studioCase(id: string): StudioCase | undefined {
  return STUDIO_CASES.find((project) => project.id === id);
}
