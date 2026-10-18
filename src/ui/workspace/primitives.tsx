import type { ItemState, Person } from "../demo-data";

export function Avatar({ person, size = "md" }: { person: Person; size?: "sm" | "md" | "lg" }) {
  const box = { sm: "h-6 w-6 text-[10px]", md: "h-9 w-9 text-xs", lg: "h-11 w-11 text-sm" }[size];
  const shape = person.role === "agent" ? "rounded-lg" : "rounded-full";
  return (
    <span className={`inline-flex shrink-0 items-center justify-center font-semibold ${box} ${shape} ${person.tone}`} aria-hidden>
      {person.initials}
    </span>
  );
}

const STATE_LABEL: Record<ItemState, { text: string; tone: string }> = {
  quote: { text: "Quote", tone: "bg-slate-100 text-slate-600" },
  proposed: { text: "Proposed", tone: "bg-blue-50 text-blue-700" },
  held: { text: "On hold", tone: "bg-amber-50 text-amber-700" },
  charged: { text: "Charged", tone: "bg-emerald-50 text-emerald-700" },
  returning: { text: "Returning", tone: "bg-violet-50 text-violet-700" },
};

export function StateChip({ state }: { state: ItemState }) {
  const { text, tone } = STATE_LABEL[state];
  return <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{text}</span>;
}

export function AgentTag() {
  return <span className="rounded bg-amber-100 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-800">Agent</span>;
}

export function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto min-w-5 rounded-full bg-[var(--primary)] px-1.5 text-center text-[11px] font-semibold leading-5 text-white">
      {count}
    </span>
  );
}
