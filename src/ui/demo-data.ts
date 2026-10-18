/**
 * Demo workspace shown until the backend exists. Amounts are in cents and follow
 * the Maple example: V1 approved at $1,500, V2 swaps the lounge chair for a desk
 * and returns the rug.
 */

export type PersonRole = "designer" | "client" | "agent";

export interface Person {
  id: string;
  name: string;
  role: PersonRole;
  /** Path under public/; people without one get a default from the avatar set. */
  avatar?: string;
}

export interface Agent extends Person {
  role: "agent";
  blurb: string;
  can: string[];
}

export type ItemState = "quote" | "proposed" | "held" | "charged" | "returning";

export interface TimelineEntry {
  at: string;
  actor: string;
  text: string;
  /** PayPal resource id or document name backing this entry. */
  ref?: string;
}

export interface Item {
  id: string;
  name: string;
  vendor: string;
  priceCents: number;
  state: ItemState;
  detail: string;
  timeline: TimelineEntry[];
}

export interface MoneyMove {
  kind: "release" | "refund" | "hold" | "charge";
  label: string;
  amountCents: number;
  note: string;
}

export interface ChangeCardData {
  title: string;
  version: string;
  status: string;
  budgetBeforeCents: number;
  budgetAfterCents: number;
  moves: MoneyMove[];
}

export type Message =
  | { kind: "date"; id: string; label: string }
  | { kind: "event"; id: string; text: string; money?: boolean }
  | { kind: "text"; id: string; author: string; text: string; time: string; file?: string }
  | { kind: "suggestion"; id: string; author: string; time: string; text: string; sources: number; drafted: boolean }
  | { kind: "change"; id: string; time: string; card: ChangeCardData };

export interface VendorFile {
  id: string;
  name: string;
  kind: string;
  summary: string;
  added: string;
}

export interface MoneySummary {
  approvedCents: number;
  proposedCents?: number;
  collectedCents: number;
  onHoldCents: number;
  refundsPromisedCents: number;
  vault: string;
}

export interface Conversation {
  id: string;
  kind: "project" | "agent";
  title: string;
  subtitle: string;
  /** The client for a project, or the agent for an agent DM. */
  counterpart: Person;
  /** Agents taking part in a project chat. */
  agents: string[];
  preview: string;
  time: string;
  unread: number;
  messages: Message[];
  items: Item[];
  money?: MoneySummary;
  files: VendorFile[];
}

export interface Alert {
  id: string;
  conversationId: string;
  text: string;
  due: string;
  urgent: boolean;
}

export const me: Person = { id: "jordan", name: "Jordan Lee", role: "designer", avatar: "/avatars/designer.webp" };

export const changeAgent: Agent = {
  id: "change-agent",
  name: "Change Agent",
  role: "agent",
  avatar: "/avatars/project-manager.webp",
  blurb: "Turns client messages into change drafts",
  can: [
    "Spots changes in project chats, including \"don't order yet\"",
    "Drafts the new version for you to price and send",
    "Ignores approvals from anyone but the approving client",
  ],
};

export const docsAgent: Agent = {
  id: "docs-agent",
  name: "Vendor Docs",
  role: "agent",
  avatar: "/avatars/supplier.webp",
  blurb: "Reads quotes, return terms and surcharge notices",
  can: [
    "Pulls price, lead time and return terms out of links, PDFs and screenshots",
    "Finds which paid or held items a surcharge notice affects",
    "Cites the page every number came from",
  ],
};

export const moneyAgent: Agent = {
  id: "money-agent",
  name: "Money Agent",
  role: "agent",
  avatar: "/avatars/budget-manager.webp",
  blurb: "Checks every dollar against PayPal and explains it",
  can: [
    "Compares what the chat says with live PayPal holds, charges and refunds",
    "Explains to clients why the budget and today's payment differ",
    "Flags holds about to expire and refunds that are due",
  ],
};

export const agents: Agent[] = [changeAgent, docsAgent, moneyAgent];

const emma: Person = { id: "emma", name: "Emma Park", role: "client", avatar: "/avatars/client.webp" };
const liam: Person = { id: "liam", name: "Liam Chen", role: "client", avatar: "/avatars/consultant.webp" };
const ava: Person = { id: "ava", name: "Ava Johnson", role: "client", avatar: "/avatars/report-specialist.webp" };
const noah: Person = { id: "noah", name: "Noah Garcia", role: "client", avatar: "/avatars/contractor.webp" };

export const people: Record<string, Person> = Object.fromEntries(
  [me, emma, liam, ava, noah, ...agents].map((p) => [p.id, p]),
);

const maple: Conversation = {
  id: "maple",
  kind: "project",
  title: "Maple Ave",
  subtitle: "Window corner",
  counterpart: emma,
  agents: ["change-agent", "docs-agent", "money-agent"],
  preview: "Money Agent: The total goes up $210, but four separate things happen...",
  time: "3:42 PM",
  unread: 2,
  messages: [
    { kind: "date", id: "m1", label: "Oct 3" },
    { kind: "event", id: "m2", text: "Emma approved V1 · 3 items · signed" },
    { kind: "event", id: "m3", money: true, text: "PayPal · $400 charged for Design services · $300 charged for Wool rug · $800 on hold for Lounge chair" },
    { kind: "date", id: "m4", label: "Today" },
    {
      kind: "text",
      id: "m5",
      author: "emma",
      time: "2:58 PM",
      text: "Let's make the window corner an office instead. Swap the lounge chair for a desk. Can you check the price first? Don't order anything yet.",
    },
    { kind: "text", id: "m6", author: "emma", time: "3:01 PM", text: "Light oak for the desk. And let's drop the rug too." },
    {
      kind: "text",
      id: "m7",
      author: "jordan",
      time: "3:05 PM",
      text: "Got it. The chair is only on hold, so nothing to refund there. The rug can go back with a 20% restocking fee. Putting the numbers together now.",
    },
    {
      kind: "suggestion",
      id: "m8",
      author: "change-agent",
      time: "3:05 PM",
      sources: 2,
      drafted: true,
      text: "Possible change: swap Lounge chair for a light oak desk and remove Wool rug. Emma asked not to order yet, so nothing moves until she approves.",
    },
    { kind: "text", id: "m9", author: "jordan", time: "3:20 PM", text: "Desk quote from Hartwood.", file: "Desk quote - Hartwood.pdf" },
    {
      kind: "change",
      id: "m10",
      time: "3:24 PM",
      card: {
        title: "Window office",
        version: "V2",
        status: "Waiting for Emma",
        budgetBeforeCents: 150_000,
        budgetAfterCents: 171_000,
        moves: [
          { kind: "release", label: "Lounge chair", amountCents: 80_000, note: "Hold released" },
          { kind: "refund", label: "Wool rug", amountCents: 24_000, note: "After vendor credit, within 5 business days" },
          { kind: "hold", label: "Light oak desk", amountCents: 110_000, note: "Charged when Hartwood confirms" },
          { kind: "charge", label: "Redesign fee", amountCents: 15_000, note: "Charged on approval" },
        ],
      },
    },
    { kind: "text", id: "m11", author: "emma", time: "3:40 PM", text: "Wait, why $1,100 now if the budget only goes up $210?" },
    {
      kind: "text",
      id: "m12",
      author: "money-agent",
      time: "3:42 PM",
      text: "The total goes up $210, but four separate things happen: the $800 chair hold is released, $240 for the rug comes back once the vendor credits it, a new $1,100 hold starts for the desk and is charged only when Hartwood confirms, and the $150 redesign fee is charged on approval.",
    },
  ],
  items: [
    {
      id: "design",
      name: "Design services",
      vendor: "Lee Studio",
      priceCents: 40_000,
      state: "charged",
      detail: "Charged Oct 3",
      timeline: [
        { at: "Oct 2", actor: "Jordan", text: "Sent in quote V1" },
        { at: "Oct 3", actor: "Emma", text: "Approved V1 and signed" },
        { at: "Oct 3", actor: "PayPal", text: "Charged $400", ref: "CAPTURE 2HX41921" },
      ],
    },
    {
      id: "chair",
      name: "Lounge chair",
      vendor: "Hart & Co",
      priceCents: 80_000,
      state: "held",
      detail: "On hold until Nov 16 · released if V2 is approved",
      timeline: [
        { at: "Oct 2", actor: "Vendor Docs", text: "Read hartandco.com: $800, 6 week lead time" },
        { at: "Oct 3", actor: "Emma", text: "Approved V1 and signed" },
        { at: "Oct 3", actor: "PayPal", text: "Put $800 on hold", ref: "AUTH 2B985819" },
        { at: "Today", actor: "Emma", text: "\"Swap the lounge chair for a desk\"" },
        { at: "Today", actor: "Jordan", text: "Sent V2: release this hold" },
      ],
    },
    {
      id: "rug",
      name: "Wool rug",
      vendor: "Loom House",
      priceCents: 30_000,
      state: "returning",
      detail: "Charged · PO #1042 · $240 refund promised in V2",
      timeline: [
        { at: "Oct 2", actor: "Jordan", text: "Sent in quote V1" },
        { at: "Oct 3", actor: "Emma", text: "Approved V1 and signed" },
        { at: "Oct 3", actor: "PayPal", text: "Charged $300", ref: "CAPTURE 7KD20448" },
        { at: "Oct 4", actor: "Loom House", text: "Confirmed stock, PO #1042 placed" },
        { at: "Today", actor: "Emma", text: "\"Let's drop the rug too\"" },
        { at: "Today", actor: "Vendor Docs", text: "Read return terms: 20% restocking fee", ref: "Rug return policy.pdf" },
        { at: "Today", actor: "Jordan", text: "Sent V2: refund $240 within 5 business days of vendor credit" },
      ],
    },
    {
      id: "desk",
      name: "Light oak desk",
      vendor: "Hartwood",
      priceCents: 110_000,
      state: "proposed",
      detail: "Proposed in V2 · hold starts on approval",
      timeline: [
        { at: "Today", actor: "Emma", text: "\"Light oak for the desk\"" },
        { at: "Today", actor: "Vendor Docs", text: "Read quote: $1,100, ships in 6 weeks", ref: "Desk quote - Hartwood.pdf" },
        { at: "Today", actor: "Jordan", text: "Checked the price and sent V2" },
      ],
    },
    {
      id: "redesign",
      name: "Redesign fee",
      vendor: "Lee Studio",
      priceCents: 15_000,
      state: "proposed",
      detail: "Proposed in V2 · charged on approval",
      timeline: [{ at: "Today", actor: "Jordan", text: "Added to V2 for the new office layout" }],
    },
  ],
  money: {
    approvedCents: 150_000,
    proposedCents: 171_000,
    collectedCents: 70_000,
    onHoldCents: 80_000,
    refundsPromisedCents: 0,
    vault: "Emma saved PayPal for this project",
  },
  files: [
    { id: "f1", name: "Desk quote - Hartwood.pdf", kind: "Quote", summary: "$1,100 · ships in 6 weeks · 15% restocking", added: "Today" },
    { id: "f2", name: "Rug return policy.pdf", kind: "Return terms", summary: "30 days · 20% restocking · buyer pays return freight", added: "Today" },
    { id: "f3", name: "Lounge chair spec sheet.pdf", kind: "Spec sheet", summary: "W 31 in · D 34 in · boucle, natural", added: "Oct 2" },
  ],
};

const oak: Conversation = {
  id: "oak",
  kind: "project",
  title: "Oak Street",
  subtitle: "Living room",
  counterpart: liam,
  agents: ["docs-agent", "money-agent"],
  preview: "Vendor Docs: A 10% surcharge affects 1 paid item.",
  time: "1:15 PM",
  unread: 1,
  messages: [
    { kind: "date", id: "o1", label: "Today" },
    { kind: "text", id: "o2", author: "jordan", time: "1:10 PM", text: "Linden Textiles sent a surcharge notice for imported fabric.", file: "Linden Textiles surcharge notice.pdf" },
    {
      kind: "suggestion",
      id: "o3",
      author: "docs-agent",
      time: "1:15 PM",
      sources: 1,
      drafted: false,
      text: "A 10% surcharge affects 1 paid item: Drapery fabric ($2,000 → $2,200). Liam saved PayPal for this project, so the $200 difference can be collected after he approves.",
    },
  ],
  items: [],
  money: { approvedCents: 640_000, collectedCents: 520_000, onHoldCents: 120_000, refundsPromisedCents: 0, vault: "Liam saved PayPal for this project" },
  files: [{ id: "f4", name: "Linden Textiles surcharge notice.pdf", kind: "Price change", summary: "+10% on imported fabric from Nov 1", added: "Today" }],
};

const birch: Conversation = {
  id: "birch",
  kind: "project",
  title: "Birch Loft",
  subtitle: "Kitchen",
  counterpart: ava,
  agents: ["money-agent"],
  preview: "Ava approved V1 and paid with Pay Later.",
  time: "11:02 AM",
  unread: 0,
  messages: [
    { kind: "date", id: "b1", label: "Today" },
    { kind: "event", id: "b2", text: "Ava approved V1 · 4 items · signed" },
    { kind: "event", id: "b3", money: true, text: "PayPal · Pay Later · $2,860 on hold until vendors confirm" },
  ],
  items: [],
  money: { approvedCents: 286_000, collectedCents: 0, onHoldCents: 286_000, refundsPromisedCents: 0, vault: "Paid with Pay Later" },
  files: [],
};

const cedar: Conversation = {
  id: "cedar",
  kind: "project",
  title: "Cedar House",
  subtitle: "Primary bedroom",
  counterpart: noah,
  agents: [],
  preview: "Can we push delivery to May?",
  time: "Mon",
  unread: 0,
  messages: [
    { kind: "date", id: "c1", label: "Monday" },
    { kind: "text", id: "c2", author: "noah", time: "4:30 PM", text: "Can we push delivery to May?" },
  ],
  items: [],
  money: { approvedCents: 410_000, collectedCents: 410_000, onHoldCents: 0, refundsPromisedCents: 0, vault: "PayPal not saved" },
  files: [],
};

function agentDm(agent: Agent, preview: string, time: string, unread: number, body: string): Conversation {
  return {
    id: `dm-${agent.id}`,
    kind: "agent",
    title: agent.name,
    subtitle: agent.blurb,
    counterpart: agent,
    agents: [agent.id],
    preview,
    time,
    unread,
    messages: [
      { kind: "date", id: `${agent.id}-d`, label: "Today" },
      { kind: "text", id: `${agent.id}-hi`, author: agent.id, time, text: body },
    ],
    items: [],
    files: [],
  };
}

const moneyDm = agentDm(
  moneyAgent,
  "Morning check: 2 holds need vendor confirmation.",
  "8:00 AM",
  1,
  "Morning check, Jordan. 2 holds need vendor confirmation before they age: Lounge chair at Maple Ave (day 2 of 3) and 2 items at Birch Loft. Every charge and refund in PayPal matches what was approved in chat.",
);

export const conversations: Conversation[] = [
  maple,
  oak,
  birch,
  cedar,
  moneyDm,
  agentDm(changeAgent, "I draft changes from your project chats.", "Yesterday", 0, "Hi Jordan, I'm Change Agent. I watch your project chats for changes, draft the new version, and leave pricing and sending to you."),
  agentDm(docsAgent, "Send me a link, PDF or screenshot.", "Yesterday", 0, "Hi Jordan, I'm Vendor Docs. Send me a product link, quote, return policy or surcharge notice and I'll pull out the numbers with the page they came from."),
];

export const alerts: Alert[] = [
  { id: "a1", conversationId: "maple", text: "Hart & Co hasn't confirmed the lounge chair", due: "Hold day 2 of 3", urgent: true },
  { id: "a2", conversationId: "oak", text: "Linden Textiles surcharge notice not handled", due: "Since 1:10 PM", urgent: false },
  { id: "a3", conversationId: "birch", text: "Check stock with 2 vendors before the holds age", due: "Due Mon", urgent: false },
];

export function usd(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}
