export function changeOrderStatusLabel(status: string): string {
  return ({
    awaiting_client_confirmation: "Awaiting client confirmation",
    approved: "Client confirmed",
    declined: "Changes requested",
    superseded: "Superseded version",
  } as Record<string, string>)[status] ?? "Status unavailable";
}

export function changeOrderStatusClass(status: string): string {
  if (status === "approved") return "bg-emerald-50 text-emerald-800";
  if (status === "superseded") return "bg-slate-100 text-slate-600";
  return "bg-amber-50 text-amber-800";
}
