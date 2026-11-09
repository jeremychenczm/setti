import type { Metadata } from "next";
import { accountCookie } from "@/accounts/server";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Maple Ave Café · Approved quote | Setti" };

export default async function MapleQuotePage() {
  return <Workspace initialView="quotes" initialQuote="maple" initialAccount={await accountCookie()} />;
}
