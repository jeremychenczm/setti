import type { Metadata } from "next";
import { requireViewer } from "@/auth/viewer";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Willow Residence · Approved quote | Setti" };

export default async function WillowQuotePage() {
  const { account, demo } = await requireViewer("/quotes/willow", "willow");
  return <Workspace account={account} demo={demo} initialView="quotes" initialQuote="willow" />;
}
