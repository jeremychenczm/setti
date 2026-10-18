import type { Metadata } from "next";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Maple Ave · Approved quote | Setti" };

export default function MapleQuotePage() {
  return <Workspace initialView="quotes" initialQuote="maple" />;
}
