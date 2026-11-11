import type { Metadata } from "next";
import { requireViewer } from "@/auth/viewer";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Maple Ave Café · Approved quote | Setti" };

export default async function MapleQuotePage() {
  const { account, demo } = await requireViewer("/quotes/maple", "maple");
  return <Workspace account={account} demo={demo} initialView="quotes" initialQuote="maple" />;
}
