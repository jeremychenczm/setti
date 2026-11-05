/**
 * Harbor Lane Residence: the fictional base project most change-draft cases use.
 * A whole-home quote with furniture, supply-only finish materials and studio services.
 */
import type { ApprovedQuoteReport } from "@/quotes/types";
import type { ProductPage } from "@/chat/types";
import { approvedQuote, option, page, type LineSpec } from "../lib/fixtures";

const NORTHWOOD = "Northwood Seating (demo)";
const ALDER = "Alder Row Furniture (demo)";
const LARKSPUR = "Larkspur Lighting (demo)";
const SALTMARSH = "Saltmarsh Textiles (demo)";
const FIELDSTONE = "Fieldstone Floor & Tile (demo)";
const HARBOR_PAINT = "Harbor Paint Co (demo)";
const PINECREST = "Pinecrest Millwork (demo)";
const BRASSWORKS = "Brassworks Hardware (demo)";
const STUDIO = "Lee Studio (studio estimate)";

const TILE_TERMS = "Fictional supplier terms: full, unopened boxes may be returned within 30 days. Opened boxes and cut pieces cannot be returned. No restocking fee has been confirmed.";
const PAINT_TERMS = "Fictional supplier terms: paint is tinted to order and cannot be returned once mixed.";
const CUSTOM_TERMS = "Fictional supplier terms: made to site measurements and cannot be returned once fabrication starts.";

export const HARBOR_LINES: LineSpec[] = [
  { itemId: "hl-sofa", name: "Four-seat sofa", room: "Living room", vendor: NORTHWOOD, sku: "NWS-SOFA-4S-LIN", specification: "Linen blend, oatmeal · 104 W × 40 D × 33 H in · kiln-dried hardwood frame · loose seat cushions", quantity: 1, unitPriceCents: 285_000, freightCents: 14_900 },
  { itemId: "hl-armchair", name: "Lounge chair", room: "Living room", vendor: NORTHWOOD, sku: "NWS-LNG-BOU-IV", specification: "Ivory boucle · 31 W × 34 D × 30 H in · price per chair", quantity: 2, unitPriceCents: 89_000 },
  { itemId: "hl-coffee-table", name: "Oak coffee table", room: "Living room", vendor: ALDER, sku: "ARF-CT-OAK-54", specification: "White oak, matte lacquer · 54 × 30 in · rounded corners", quantity: 1, unitPriceCents: 115_000 },
  { itemId: "hl-side-table", name: "Marble side table", room: "Living room", vendor: ALDER, sku: "ARF-ST-MRB-18", specification: "Carrara marble top, blackened steel base · 18 in diameter · price per table", quantity: 2, unitPriceCents: 42_000 },
  { itemId: "hl-living-rug", name: "Wool area rug, living room", room: "Living room", vendor: SALTMARSH, sku: "SMT-RUG-WL-912", specification: "Hand-loomed wool, ivory and sand stripe · 9 × 12 ft · rug pad included", quantity: 1, unitPriceCents: 168_000 },
  { itemId: "hl-floor-lamp", name: "Arc floor lamp", room: "Living room", vendor: LARKSPUR, sku: "LKL-FL-ARC-BR", specification: "Brushed brass arc, linen drum shade · 82 in high · dimmable LED", quantity: 1, unitPriceCents: 54_000 },
  { itemId: "hl-media-console", name: "Walnut media console", room: "Living room", vendor: ALDER, sku: "ARF-MC-WAL-84", specification: "Walnut veneer, four cane doors · 84 W × 18 D × 24 H in", quantity: 1, unitPriceCents: 195_000 },
  { itemId: "hl-dining-table", name: "Extendable dining table", room: "Dining room", vendor: ALDER, sku: "ARF-DT-EXT-84", specification: "White oak · 84 in, extends to 108 in with two leaves · seats 6–10", quantity: 1, unitPriceCents: 320_000, freightCents: 9_900 },
  { itemId: "hl-dining-chair", name: "Upholstered dining chair", room: "Dining room", vendor: NORTHWOOD, sku: "NWS-DC-UPH-FLX", specification: "Performance flax fabric, oak legs · 20 W × 23 D × 32 H in · price per chair", quantity: 6, unitPriceCents: 46_500 },
  { itemId: "hl-dining-pendant", name: "Dining pendant", room: "Dining room", vendor: LARKSPUR, sku: "LKL-PD-GLB-30", specification: "Hand-blown opal glass globe · 30 in diameter · hardwired, electrician installs", quantity: 1, unitPriceCents: 78_000 },
  { itemId: "hl-sideboard", name: "Oak sideboard", room: "Dining room", vendor: ALDER, sku: "ARF-SB-OAK-72", specification: "White oak, fluted doors · 72 W × 18 D × 32 H in", quantity: 1, unitPriceCents: 240_000 },
  { itemId: "hl-bed", name: "Queen upholstered bed", room: "Primary bedroom", vendor: NORTHWOOD, sku: "NWS-BED-Q-WNG", specification: "Wingback headboard in mushroom velvet · queen · slatted base, no box spring needed", quantity: 1, unitPriceCents: 210_000 },
  { itemId: "hl-nightstand", name: "Two-drawer nightstand", room: "Primary bedroom", vendor: ALDER, sku: "ARF-NS-OAK-24", specification: "White oak · 24 W × 16 D × 26 H in · price per nightstand", quantity: 2, unitPriceCents: 56_000 },
  { itemId: "hl-dresser", name: "Six-drawer dresser", room: "Primary bedroom", vendor: ALDER, sku: "ARF-DR-OAK-66", specification: "White oak, leather pulls · 66 W × 20 D × 32 H in", quantity: 1, unitPriceCents: 189_000 },
  { itemId: "hl-bedroom-rug", name: "Wool area rug, bedroom", room: "Primary bedroom", vendor: SALTMARSH, sku: "SMT-RUG-WL-810", specification: "Flatweave wool, oat · 8 × 10 ft · rug pad included", quantity: 1, unitPriceCents: 124_000 },
  { itemId: "hl-curtains", name: "Linen drapery panel", room: "Primary bedroom", vendor: SALTMARSH, sku: "SMT-DRP-LIN-96", specification: "Pinch-pleat linen, blackout lining · 50 W × 96 L in · price per panel", quantity: 4, unitPriceCents: 18_500 },
  { itemId: "hl-entry-console", name: "Entry console table", room: "Entry", vendor: ALDER, sku: "ARF-EC-OAK-48", specification: "White oak, open shelf · 48 W × 14 D × 30 H in", quantity: 1, unitPriceCents: 78_000 },
  { itemId: "hl-entry-mirror", name: "Round entry mirror", room: "Entry", vendor: ALDER, sku: "ARF-MIR-RND-36", specification: "Brass frame · 36 in diameter", quantity: 1, unitPriceCents: 42_000 },
  { itemId: "hl-oak-flooring", name: "Engineered oak flooring", room: "Living room / Dining room", vendor: FIELDSTONE, sku: "FFT-EOK-NAT-75", specification: "Natural white oak, matte · 7 1/2 in planks, 1/2 in thick · 22.0 sq ft per box · 28 boxes for about 560 sq ft plus 10% for cuts · installation by the client's contractor", quantity: 28, unitLabel: "box", unitPriceCents: 10_980, returnPolicy: TILE_TERMS },
  { itemId: "hl-backsplash-tile", name: "Zellige backsplash tile", room: "Kitchen", vendor: FIELDSTONE, sku: "FFT-ZEL-WHT-4", specification: "Glazed white zellige · 4 × 4 in · 10.8 sq ft per box · 6 boxes for about 58 sq ft · setting materials and installation by the client's contractor", quantity: 6, unitLabel: "box", unitPriceCents: 16_200, returnPolicy: TILE_TERMS },
  { itemId: "hl-bath-floor-tile", name: "Porcelain hex floor tile", room: "Primary bath", vendor: FIELDSTONE, sku: "FFT-HEX-GRY-2", specification: "Matte warm gray porcelain · 2 in hex on mesh · 10.0 sq ft per box · 5 boxes for about 45 sq ft", quantity: 5, unitLabel: "box", unitPriceCents: 6_850, returnPolicy: TILE_TERMS },
  { itemId: "hl-shower-tile", name: "Glazed shower wall tile", room: "Primary bath", vendor: FIELDSTONE, sku: "FFT-SUB-WHT-38", specification: "Glossy white ceramic · 3 × 8 in · 12.5 sq ft per box · 9 boxes for about 105 sq ft of shower walls", quantity: 9, unitLabel: "box", unitPriceCents: 9_400, returnPolicy: TILE_TERMS },
  { itemId: "hl-wall-paint", name: "Interior wall paint", room: "Whole home", vendor: HARBOR_PAINT, sku: "HPC-INT-EGG-WW", specification: "Eggshell acrylic, tinted warm white · 14 gallons for two coats on about 2,600 sq ft of walls · labor not included", quantity: 14, unitLabel: "gallon", unitPriceCents: 7_299, customMade: true, nonReturnable: true, returnPolicy: PAINT_TERMS },
  { itemId: "hl-trim-paint", name: "Trim paint", room: "Whole home", vendor: HARBOR_PAINT, sku: "HPC-TRM-SG-WW", specification: "Semi-gloss enamel, tinted warm white · 4 gallons for doors, casings and baseboards", quantity: 4, unitLabel: "gallon", unitPriceCents: 7_999, customMade: true, nonReturnable: true, returnPolicy: PAINT_TERMS },
  { itemId: "hl-downlights", name: "Recessed LED downlight", room: "Living room / Kitchen", vendor: LARKSPUR, sku: "LKL-RDL-4IN-5CC", specification: "4 in canless wafer, IC-rated, dimmable · selectable 2700–5000 K · price per light · electrician installs", quantity: 10, unitPriceCents: 3_650 },
  { itemId: "hl-island-pendants", name: "Kitchen island pendant", room: "Kitchen", vendor: LARKSPUR, sku: "LKL-PD-DOME-16", specification: "Spun aluminum dome, matte black · 16 in · hardwired · price per pendant", quantity: 2, unitPriceCents: 64_000 },
  { itemId: "hl-cabinet-pulls", name: "Brass cabinet pull", room: "Kitchen", vendor: BRASSWORKS, sku: "BWH-PULL-6-UNL", specification: "Unlacquered brass · 6 in center to center · price per pull", quantity: 28, unitPriceCents: 1_840 },
  { itemId: "hl-vanity", name: "Custom oak vanity", room: "Primary bath", vendor: PINECREST, sku: "PCM-VAN-48-OAK", specification: "Rift white oak, two drawers · 48 W × 21 D in · made to site measurements · installation by the client's contractor", quantity: 1, unitPriceCents: 360_000, leadTimeDays: 42, customMade: true, nonReturnable: true, returnPolicy: CUSTOM_TERMS },
  { itemId: "hl-quartz", name: "Quartz countertop, fabricated", room: "Kitchen", vendor: PINECREST, sku: "PCM-QTZ-CAL-3CM", specification: "Calacatta-look quartz, 3 cm · template, fabrication and delivery for about 48 sq ft with undermount sink cut-out", quantity: 1, unitPriceCents: 485_000, leadTimeDays: 21, customMade: true, nonReturnable: true, returnPolicy: CUSTOM_TERMS },
  { itemId: "hl-bath-faucet", name: "Widespread bath faucet", room: "Primary bath", vendor: BRASSWORKS, sku: "BWH-FCT-WS-BRS", specification: "Brushed brass, lever handles · 8 in widespread · valve included", quantity: 1, unitPriceCents: 48_500 },
  { itemId: "hl-design-development", name: "Design development", room: "Whole home", vendor: STUDIO, sku: "EST-HL-DESIGN", specification: "Layouts, finish selections and drawings · 40 hours × $150/hour", quantity: 40, unitPriceCents: 15_000, category: "service" },
  { itemId: "hl-procurement", name: "Procurement and tracking", room: "Whole home", vendor: STUDIO, sku: "EST-HL-PROCURE", specification: "Orders, tracking and receiving · 12 hours × $110/hour", quantity: 12, unitPriceCents: 11_000, category: "service" },
  { itemId: "hl-site-visits", name: "Site visits", room: "Whole home", vendor: STUDIO, sku: "EST-HL-VISIT", specification: "Contractor coordination visits · 6 visits × $250/visit", quantity: 6, unitLabel: "visit", unitPriceCents: 25_000, category: "service" },
];

export function harborQuote(edit?: (lines: LineSpec[]) => LineSpec[]): ApprovedQuoteReport {
  const lines = structuredClone(HARBOR_LINES);
  return approvedQuote({
    id: "eval-harbor-v1", projectId: "eval-harbor-lane", projectName: "Harbor Lane Residence", clientName: "Nora Patel",
    rooms: "Living room · Dining room · Kitchen · Primary bedroom · Primary bath · Entry",
    lines: edit ? edit(lines) : lines,
  });
}

export const SOFA_URL = "https://www.northwood-seating.example/sofas/haven";
export const BENCH_URL = "https://www.northwood-seating.example/benches/ridge";
export const HEX_URL = "https://www.fieldstone-floor.example/tile/terrace-hex";
export const ORB_URL = "https://www.larkspur-lighting.example/pendants/orb";

export function sofaPage(note = ""): ProductPage {
  return page(SOFA_URL, "Haven sofa | Northwood Seating", `Haven sofa collection. Kiln-dried hardwood frame, sinuous springs, removable covers. Made to order in 4–6 weeks.${note}`, [
    option({ id: "haven-3s-oat", name: "Haven three-seat sofa, oatmeal", sku: "NWS-HVN-3S-OAT", seller: NORTHWOOD, specification: "Oatmeal linen blend · 86 W × 38 D × 32 H in", unitPriceCents: 239_000, unitLabel: "each" }),
    option({ id: "haven-3s-slate", name: "Haven three-seat sofa, slate", sku: "NWS-HVN-3S-SLT", seller: NORTHWOOD, specification: "Slate linen blend · 86 W × 38 D × 32 H in", unitPriceCents: 239_000, unitLabel: "each" }),
    option({ id: "haven-4s-oat", name: "Haven four-seat sofa, oatmeal", sku: "NWS-HVN-4S-OAT", seller: NORTHWOOD, specification: "Oatmeal linen blend · 104 W × 38 D × 32 H in", unitPriceCents: 298_000, unitLabel: "each" }),
  ]);
}

export function benchPage(note = "", benchSpec = "White oak, woven seagrass seat · 48 W × 16 D × 18 H in"): ProductPage {
  return page(BENCH_URL, "Ridge bench | Northwood Seating", `Ridge bench. Solid white oak frame, hand-woven seagrass seat.${note}`, [
    option({ id: "ridge-bench-48", name: "Ridge bench, 48 in", sku: "NWS-RDG-48", seller: NORTHWOOD, specification: benchSpec, unitPriceCents: 62_000, unitLabel: "each" }),
    option({ id: "ridge-bench-60", name: "Ridge bench, 60 in", sku: "NWS-RDG-60", seller: NORTHWOOD, specification: "White oak, woven seagrass seat · 60 W × 16 D × 18 H in", unitPriceCents: 74_000, unitLabel: "each" }),
  ]);
}

export function hexPage(note = "", sageNote = ""): ProductPage {
  return page(HEX_URL, "Terrace hex tile | Fieldstone Floor & Tile", `Terrace handmade-look hex, 3 in, glazed ceramic. Sold by the box of 10.8 sq ft. Full boxes only.${note}`, [
    option({ id: "terrace-hex-white", name: "Terrace hex tile, chalk white", sku: "FFT-TRC-HEX-WHT", seller: FIELDSTONE, specification: "Glazed ceramic · 3 in hex · 10.8 sq ft per box", unitPriceCents: 7_240, unitLabel: "box" }),
    option({ id: "terrace-hex-sage", name: "Terrace hex tile, sage", sku: "FFT-TRC-HEX-SGE", seller: FIELDSTONE, specification: `Glazed ceramic · 3 in hex · 10.8 sq ft per box${sageNote}`, unitPriceCents: 7_240, unitLabel: "box" }),
  ]);
}

export const RUG_URL = "https://www.saltmarsh-textiles.example/rugs/dune";

/** Four near-identical rugs: only the border, the size and the color tell them apart. */
export function rugPage(): ProductPage {
  return page(RUG_URL, "Dune flatweave rug | Saltmarsh Textiles", "Dune flatweave wool rugs, woven to order in 3–4 weeks. Rug pad sold separately.", [
    option({ id: "dune-810-oat", name: "Dune rug, oat", sku: "SMT-DUN-810-OAT", seller: SALTMARSH, specification: "Flatweave wool, oat · 8 × 10 ft", unitPriceCents: 98_000, unitLabel: "each" }),
    option({ id: "dune-810-oat-border", name: "Dune rug, oat with ivory border", sku: "SMT-DUN-810-OIB", seller: SALTMARSH, specification: "Flatweave wool, oat with a 4 in ivory border · 8 × 10 ft", unitPriceCents: 112_000, unitLabel: "each" }),
    option({ id: "dune-912-oat", name: "Dune rug, oat", sku: "SMT-DUN-912-OAT", seller: SALTMARSH, specification: "Flatweave wool, oat · 9 × 12 ft", unitPriceCents: 138_000, unitLabel: "each" }),
    option({ id: "dune-810-sand", name: "Dune rug, sand", sku: "SMT-DUN-810-SND", seller: SALTMARSH, specification: "Flatweave wool, sand · 8 × 10 ft", unitPriceCents: 98_000, unitLabel: "each" }),
  ]);
}

export function orbPage(note = ""): ProductPage {
  return page(ORB_URL, "Orb pendant | Larkspur Lighting", `Orb pendant in hand-blown opal glass with a brass canopy. Hardwired; a licensed electrician installs.${note}`, [
    option({ id: "orb-18-brass", name: "Orb pendant 18 in, brass", sku: "LKL-ORB-18-BR", seller: LARKSPUR, specification: "Opal glass, brass canopy · 18 in diameter · hardwired", unitPriceCents: 69_000, unitLabel: "each" }),
    option({ id: "orb-24-brass", name: "Orb pendant 24 in, brass", sku: "LKL-ORB-24-BR", seller: LARKSPUR, specification: "Opal glass, brass canopy · 24 in diameter · hardwired", unitPriceCents: 89_000, unitLabel: "each" }),
  ]);
}
