/**
 * Cedar Ridge House: a fictional whole-house quote generated room by room, with
 * the same kinds of items repeated across rooms (several nightstands, oak
 * flooring in many rooms) so a change must name the right room's line.
 * Deterministic: the same line count always gives the same quote.
 */
import type { ApprovedQuoteReport } from "@/quotes/types";
import { approvedQuote, type LineSpec } from "./fixtures";

type RoomKind = "entry" | "living" | "dining" | "kitchen" | "pantry" | "bath" | "mudroom" | "office" | "bedroom" | "closet" | "laundry" | "gym" | "hall" | "patio";

/** slug, name, vendor, sku stem, specification, quantity, unit, unit price in cents, made to order. */
type Template = readonly [slug: string, name: string, vendor: string, sku: string, specification: string, quantity: number, unit: string, cents: number, custom?: boolean];

const V = {
  seating: "Northwood Seating (demo)", furniture: "Alder Row Furniture (demo)", lighting: "Larkspur Lighting (demo)", textiles: "Saltmarsh Textiles (demo)",
  floor: "Fieldstone Floor & Tile (demo)", paint: "Harbor Paint Co (demo)", millwork: "Pinecrest Millwork (demo)", hardware: "Brassworks Hardware (demo)",
  plumbing: "Clearwater Plumbing Supply (demo)", outdoor: "Tidewater Outdoor (demo)",
};

const FLOOR = (boxes: number): Template => ["oak-flooring", "Engineered oak flooring", V.floor, "FFT-EOK", `Natural white oak, matte · 7 1/2 in planks · 22.0 sq ft per box · ${boxes} boxes including 10% for cuts · underlayment and installation by the client's contractor`, boxes, "box", 10_980];
const PAINT = (gallons: number): Template => ["wall-paint", "Interior wall paint", V.paint, "HPC-EGG", `Eggshell acrylic, tinted to the room's approved color · ${gallons} gallons for two coats · ceilings, trim and labor not included`, gallons, "gallon", 7_299, true];

const TEMPLATES: Record<RoomKind, readonly Template[]> = {
  entry: [["console", "Console table", V.furniture, "ARF-EC", "White oak, open shelf · 48 W × 14 D × 30 H in", 1, "each", 78_000], ["mirror", "Round mirror", V.furniture, "ARF-MIR", "Brass frame · 36 in diameter", 1, "each", 42_000], ["runner", "Wool runner rug", V.textiles, "SMT-RUN", "Flatweave wool · 2 ft 6 in × 10 ft", 1, "each", 46_000], ["pendant", "Lantern pendant", V.lighting, "LKL-LAN", "Seeded glass lantern · 14 in · hardwired", 1, "each", 52_000], ["floor-tile", "Porcelain floor tile", V.floor, "FFT-POR", "Warm gray matte porcelain · 12 × 24 in · 15.5 sq ft per box", 5, "box", 4_635], PAINT(3), ["hooks", "Wall hook", V.hardware, "BWH-HOOK", "Unlacquered brass double hook · price per hook", 6, "each", 2_400]],
  living: [["sofa", "Sofa", V.seating, "NWS-SOFA", "Linen blend, oatmeal · 96 W × 38 D × 32 H in", 1, "each", 265_000], ["lounge-chair", "Lounge chair", V.seating, "NWS-LNG", "Ivory boucle · price per chair", 2, "each", 89_000], ["coffee-table", "Coffee table", V.furniture, "ARF-CT", "White oak, matte lacquer · 54 × 30 in", 1, "each", 115_000], ["side-table", "Side table", V.furniture, "ARF-ST", "Marble top, steel base · 18 in · price per table", 2, "each", 42_000], ["area-rug", "Wool area rug", V.textiles, "SMT-RUG", "Hand-loomed wool · 9 × 12 ft · pad included", 1, "each", 168_000], ["floor-lamp", "Floor lamp", V.lighting, "LKL-FL", "Brass, linen shade · dimmable LED", 1, "each", 54_000], ["media-console", "Media console", V.furniture, "ARF-MC", "Walnut veneer, cane doors · 84 W × 18 D in", 1, "each", 195_000], ["bookshelf", "Bookshelf", V.furniture, "ARF-BK", "White oak · 36 W × 14 D × 84 H in", 1, "each", 128_000], ["curtains", "Linen drapery panel", V.textiles, "SMT-DRP", "Pinch-pleat linen · 50 W × 96 L in · price per panel", 4, "each", 18_500], FLOOR(18), PAINT(5), ["downlights", "Recessed LED downlight", V.lighting, "LKL-RDL", "4 in canless wafer, dimmable · price per light · electrician installs", 6, "each", 3_650], ["dimmers", "Smart dimmer switch", V.lighting, "LKL-DIM", "Single-pole, neutral required · price per switch", 3, "each", 6_400]],
  dining: [["dining-table", "Dining table", V.furniture, "ARF-DT", "White oak · 84 in, extends to 108 in", 1, "each", 320_000], ["dining-chair", "Dining chair", V.seating, "NWS-DC", "Performance flax, oak legs · price per chair", 8, "each", 46_500], ["pendant", "Dining pendant", V.lighting, "LKL-PD", "Opal glass globe · 30 in · hardwired", 1, "each", 78_000], ["sideboard", "Sideboard", V.furniture, "ARF-SB", "White oak, fluted doors · 72 W in", 1, "each", 240_000], ["area-rug", "Wool area rug", V.textiles, "SMT-RUG", "Flatweave wool · 9 × 12 ft", 1, "each", 142_000], FLOOR(16), PAINT(4), ["curtains", "Linen drapery panel", V.textiles, "SMT-DRP", "Pinch-pleat linen · price per panel", 4, "each", 18_500]],
  kitchen: [["cabinetry", "Kitchen cabinetry", V.millwork, "PCM-CAB", "Painted shaker, soft-close · made to site measurements · installation by the client's contractor", 1, "each", 1_840_000, true], ["countertop", "Quartz countertop, fabricated", V.millwork, "PCM-QTZ", "Calacatta-look quartz, 3 cm · template, fabrication and delivery", 1, "each", 485_000, true], ["backsplash-tile", "Zellige backsplash tile", V.floor, "FFT-ZEL", "Glazed zellige · 4 × 4 in · 10.8 sq ft per box", 6, "box", 16_200], ["island-pendant", "Island pendant", V.lighting, "LKL-DOME", "Spun aluminum dome · 16 in · price per pendant", 2, "each", 64_000], ["cabinet-pull", "Cabinet pull", V.hardware, "BWH-PULL", "Unlacquered brass · 6 in · price per pull", 30, "each", 1_840], ["sink", "Fireclay farmhouse sink", V.plumbing, "CWP-SNK", "White fireclay · 33 in apron front", 1, "each", 118_000], ["faucet", "Kitchen faucet", V.plumbing, "CWP-KF", "Brushed brass pull-down", 1, "each", 62_000], ["counter-stool", "Counter stool", V.seating, "NWS-CS", "Oak, leather seat · 26 in seat height · price per stool", 3, "each", 38_000], FLOOR(14), PAINT(3), ["downlights", "Recessed LED downlight", V.lighting, "LKL-RDL", "4 in canless wafer · price per light", 8, "each", 3_650]],
  pantry: [["shelving", "Pantry shelving", V.millwork, "PCM-PSH", "Painted birch plywood, adjustable · made to site measurements", 1, "each", 280_000, true], ["floor-tile", "Porcelain floor tile", V.floor, "FFT-POR", "Matte porcelain · 12 × 24 in · 15.5 sq ft per box", 3, "box", 4_635], PAINT(2), ["ceiling-light", "Flush ceiling light", V.lighting, "LKL-FM", "Opal glass · 12 in", 1, "each", 24_000], ["baskets", "Woven storage basket", V.textiles, "SMT-BSK", "Seagrass · 14 in · price per basket", 6, "each", 4_800]],
  bath: [["vanity", "Custom vanity", V.millwork, "PCM-VAN", "Rift white oak · made to site measurements · installation by the client's contractor", 1, "each", 360_000, true], ["faucet", "Bath faucet", V.plumbing, "CWP-BF", "Brushed brass, 8 in widespread", 1, "each", 48_500], ["floor-tile", "Porcelain hex floor tile", V.floor, "FFT-HEX", "Matte gray porcelain · 2 in hex · 10.0 sq ft per box", 5, "box", 6_850], ["wall-tile", "Glazed wall tile", V.floor, "FFT-SUB", "Glossy white ceramic · 3 × 8 in · 12.5 sq ft per box", 9, "box", 9_400], ["mirror", "Vanity mirror", V.furniture, "ARF-VM", "Brass frame · 24 × 36 in", 1, "each", 36_000], ["sconce", "Wall sconce", V.lighting, "LKL-SC", "Opal glass, brass · damp rated · price per sconce", 2, "each", 28_000], ["towel-bar", "Towel bar", V.hardware, "BWH-TB", "Unlacquered brass · 24 in", 1, "each", 12_800], ["toilet", "Toilet", V.plumbing, "CWP-WC", "Elongated, comfort height · 1.28 gpf", 1, "each", 64_000], ["shower-trim", "Shower valve trim", V.plumbing, "CWP-SV", "Brushed brass thermostatic trim · valve by the plumber", 1, "each", 58_000], ["exhaust-fan", "Exhaust fan", V.lighting, "LKL-FAN", "Quiet 110 CFM with humidity sensor", 1, "each", 21_000], PAINT(2)],
  mudroom: [["bench", "Storage bench", V.furniture, "ARF-BEN", "White oak, cubbies below · 60 W in", 1, "each", 96_000], ["cubbies", "Locker cubbies", V.millwork, "PCM-LKR", "Painted birch · four bays · made to site measurements", 1, "each", 340_000, true], ["hooks", "Wall hook", V.hardware, "BWH-HOOK", "Unlacquered brass · price per hook", 8, "each", 2_400], ["floor-tile", "Slate-look floor tile", V.floor, "FFT-SLT", "Textured porcelain · 12 × 24 in · 15.5 sq ft per box", 4, "box", 5_200], PAINT(2), ["sconce", "Wall sconce", V.lighting, "LKL-SC", "Opal glass · price per sconce", 2, "each", 28_000]],
  office: [["desk", "Writing desk", V.furniture, "ARF-DSK", "White oak · 60 × 28 in", 1, "each", 148_000], ["task-chair", "Task chair", V.seating, "NWS-TC", "Wool upholstery, adjustable", 1, "each", 72_000], ["bookcase", "Bookcase", V.furniture, "ARF-BC", "White oak · 32 W × 84 H in · price per bookcase", 2, "each", 98_000], ["built-in-shelving", "Built-in wall shelving", V.millwork, "PCM-BIS", "Paint-grade birch · 96 W × 12 D × 48 H in · made to site measurements", 1, "each", 320_000, true], ["floor-lamp", "Floor lamp", V.lighting, "LKL-FL", "Brass task lamp", 1, "each", 38_000], ["area-rug", "Wool area rug", V.textiles, "SMT-RUG", "Flatweave wool · 6 × 9 ft", 1, "each", 86_000], FLOOR(8), PAINT(3), ["curtains", "Linen drapery panel", V.textiles, "SMT-DRP", "Linen · price per panel", 2, "each", 18_500]],
  bedroom: [["bed", "Upholstered bed", V.seating, "NWS-BED", "Wingback headboard, velvet · queen", 1, "each", 210_000], ["nightstand", "Nightstand", V.furniture, "ARF-NS", "White oak, two drawers · price per nightstand", 2, "each", 56_000], ["dresser", "Dresser", V.furniture, "ARF-DR", "White oak, six drawers · 66 W in", 1, "each", 189_000], ["bench", "Bed bench", V.seating, "NWS-BB", "Linen upholstery · 54 W in", 1, "each", 68_000], ["area-rug", "Wool area rug", V.textiles, "SMT-RUG", "Flatweave wool · 8 × 10 ft", 1, "each", 124_000], ["table-lamp", "Table lamp", V.lighting, "LKL-TL", "Ceramic base, linen shade · price per lamp", 2, "each", 32_000], ["curtains", "Linen drapery panel", V.textiles, "SMT-DRP", "Blackout-lined linen · price per panel", 4, "each", 18_500], FLOOR(12), PAINT(4), ["ceiling-fixture", "Ceiling fixture", V.lighting, "LKL-CF", "Semi-flush, linen drum · 18 in", 1, "each", 34_000], ["closet-system", "Closet system", V.millwork, "PCM-CLS", "Painted melamine, drawers and rods · made to site measurements", 1, "each", 260_000, true]],
  closet: [["closet-system", "Walk-in closet system", V.millwork, "PCM-WIC", "Painted shaker, island with drawers · made to site measurements", 1, "each", 920_000, true], ["ottoman", "Closet ottoman", V.seating, "NWS-OTT", "Velvet · 36 in round", 1, "each", 64_000], ["mirror", "Floor mirror", V.furniture, "ARF-FM", "Oak frame · 30 × 72 in", 1, "each", 68_000], FLOOR(6), ["ceiling-light", "Flush ceiling light", V.lighting, "LKL-FM", "Opal glass · 16 in", 1, "each", 26_000]],
  laundry: [["cabinets", "Laundry cabinets", V.millwork, "PCM-LDC", "Painted shaker · made to site measurements", 1, "each", 410_000, true], ["counter", "Laminate counter", V.millwork, "PCM-LAM", "Matte laminate over washer and dryer · 72 in", 1, "each", 54_000, true], ["utility-sink", "Utility sink", V.plumbing, "CWP-US", "Stainless, 24 in", 1, "each", 42_000], ["faucet", "Utility faucet", V.plumbing, "CWP-UF", "Chrome pull-down", 1, "each", 22_000], ["floor-tile", "Porcelain floor tile", V.floor, "FFT-POR", "Matte porcelain · 15.5 sq ft per box", 4, "box", 4_635], PAINT(2)],
  gym: [["rubber-flooring", "Rubber gym flooring", V.floor, "FFT-RUB", "8 mm recycled rubber rolls · 4 × 25 ft per roll", 3, "roll", 38_000], ["mirror-wall", "Wall mirror panels", V.furniture, "ARF-MWP", "Frameless safety-backed glass · 36 × 72 in · price per panel", 4, "each", 22_000], PAINT(3), ["downlights", "Recessed LED downlight", V.lighting, "LKL-RDL", "4 in canless wafer · price per light", 6, "each", 3_650], ["ceiling-fan", "Ceiling fan", V.lighting, "LKL-CFN", "52 in, matte white, DC motor", 1, "each", 46_000]],
  hall: [["runner", "Wool runner rug", V.textiles, "SMT-RUN", "Flatweave wool · 2 ft 6 in × 14 ft", 1, "each", 58_000], ["flush-light", "Flush ceiling light", V.lighting, "LKL-FM", "Opal glass · 14 in · price per light", 3, "each", 24_000], PAINT(3), ["art-lights", "Picture light", V.lighting, "LKL-PIC", "Brass, 14 in · price per light", 2, "each", 18_000]],
  patio: [["outdoor-sofa", "Outdoor sofa", V.outdoor, "TWO-SOF", "Teak frame, performance cushions · 84 W in", 1, "each", 340_000], ["outdoor-chair", "Outdoor lounge chair", V.outdoor, "TWO-LCH", "Teak, sling seat · price per chair", 2, "each", 98_000], ["outdoor-table", "Outdoor dining table", V.outdoor, "TWO-ODT", "Teak · 72 × 38 in", 1, "each", 210_000], ["outdoor-dining-chair", "Outdoor dining chair", V.outdoor, "TWO-ODC", "Teak, rope seat · price per chair", 6, "each", 42_000], ["umbrella", "Market umbrella", V.outdoor, "TWO-UMB", "9 ft, sand canvas", 1, "each", 64_000], ["string-lights", "Outdoor string lights", V.lighting, "LKL-OSL", "48 ft, commercial grade", 2, "each", 12_000]],
};

const ROOMS: readonly (readonly [room: string, kind: RoomKind])[] = [
  ["Entry", "entry"], ["Living room", "living"], ["Family room", "living"], ["Dining room", "dining"], ["Kitchen", "kitchen"], ["Pantry", "pantry"],
  ["Powder room", "bath"], ["Mudroom", "mudroom"], ["Den", "living"], ["Office", "office"], ["Primary bedroom", "bedroom"], ["Primary bath", "bath"],
  ["Primary closet", "closet"], ["Guest bedroom 1", "bedroom"], ["Guest bath 1", "bath"], ["Guest bedroom 2", "bedroom"], ["Guest bath 2", "bath"],
  ["Kids' room", "bedroom"], ["Kids' bath", "bath"], ["Laundry", "laundry"], ["Media room", "living"], ["Gym", "gym"], ["Sunroom", "living"],
  ["Upstairs hall", "hall"], ["Stair hall", "hall"], ["Patio", "patio"],
  ["Cottage living room", "living"], ["Cottage kitchen", "kitchen"], ["Cottage bedroom", "bedroom"], ["Cottage bath", "bath"], ["Cottage porch", "patio"],
];

const slug = (text: string) => text.toLowerCase().replace(/['’]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

/** The item id a case uses for one room's line, for example cedarItem("Guest bedroom 2", "nightstand"). */
export function cedarItem(room: string, item: string): string {
  return `cr-${slug(room)}-${item}`;
}

/** A small deterministic price spread, so the same item differs slightly from room to room. */
function priceFor(cents: number, index: number): number {
  const step = [0, 4, -3, 7, -5, 2, 9, -6][index % 8];
  return Math.max(100, Math.round((cents * (100 + step)) / 100));
}

const DETAIL = [
  "Finish sample approved at the October 14 design meeting.",
  "Confirm the final dimensions on site before the order is released.",
  "Deliver to the garage staging area; the contractor receives and inspects.",
  "Color and dye-lot to match the other rooms where the same item appears.",
];

function roomLines(room: string, kind: RoomKind, roomIndex: number): LineSpec[] {
  return TEMPLATES[kind].map(([item, name, vendor, sku, specification, quantity, unit, cents, custom], index) => ({
    itemId: cedarItem(room, item), name, room, vendor, sku: `${sku}-${String(roomIndex + 1).padStart(2, "0")}${String(index + 1).padStart(2, "0")}`,
    specification: `${room}: ${specification} · ${DETAIL[(roomIndex + index) % DETAIL.length]}`,
    quantity, unitLabel: unit, unitPriceCents: priceFor(cents, roomIndex + index),
    ...(custom ? { customMade: true, nonReturnable: true, leadTimeDays: 35, returnPolicy: "Fictional supplier terms: made to order or to site measurements; cannot be returned once fabrication or tinting starts." } : {}),
  }));
}

const SERVICES: LineSpec[] = [
  { itemId: "cr-design-development", name: "Design development", room: "Whole house", vendor: "Lee Studio (studio estimate)", sku: "EST-CR-DESIGN", specification: "Layouts, finish schedules and drawings for every room · 160 hours × $150/hour", quantity: 160, unitPriceCents: 15_000, category: "service" },
  { itemId: "cr-procurement", name: "Procurement and tracking", room: "Whole house", vendor: "Lee Studio (studio estimate)", sku: "EST-CR-PROCURE", specification: "Orders, tracking, receiving and claims · 60 hours × $110/hour", quantity: 60, unitPriceCents: 11_000, category: "service" },
  { itemId: "cr-site-visits", name: "Site visits", room: "Whole house", vendor: "Lee Studio (studio estimate)", sku: "EST-CR-VISIT", specification: "Contractor coordination visits · 20 visits × $250/visit", quantity: 20, unitLabel: "visit", unitPriceCents: 25_000, category: "service" },
];

/** All goods lines in room order, before services. */
export function cedarGoods(): LineSpec[] {
  return ROOMS.flatMap(([room, kind], index) => roomLines(room, kind, index));
}

/** The first `rooms` rooms of the house, plus studio services. */
export function cedarQuote(rooms: number): ApprovedQuoteReport {
  const chosen = ROOMS.slice(0, rooms);
  return approvedQuote({
    id: `eval-cedar-${rooms}-v1`, projectId: "eval-cedar-ridge", projectName: "Cedar Ridge House", clientName: "Daniel Okafor",
    rooms: chosen.map(([room]) => room).join(" · "),
    lines: [...chosen.flatMap(([room, kind], index) => roomLines(room, kind, index)), ...SERVICES],
  });
}

export const CEDAR_ROOM_COUNT = ROOMS.length;
