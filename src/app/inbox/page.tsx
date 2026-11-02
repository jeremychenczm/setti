import type { Metadata } from "next";
import { accountOrDefault } from "@/accounts/demo";
import { accountCookie } from "@/accounts/server";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Inbox | Setti", robots: { index: false, follow: false } };

export default async function InboxPage() {
  const account = accountOrDefault(await accountCookie());
  return <Workspace initialView="inbox" initialAccount={account.id} />;
}
