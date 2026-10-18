import type { Metadata } from "next";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Willow Residence · Approved quote | Setti" };

export default function WillowQuotePage() {
  return <Workspace initialView="quotes" initialQuote="willow" />;
}
