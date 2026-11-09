import type { Metadata } from "next";
import { accountCookie } from "@/accounts/server";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Maple Ave Café · Project chat | Setti" };

export default async function MapleChatPage() {
  return <Workspace initialView="chats" initialCase="maple" initialQuote="maple" initialAccount={await accountCookie()} />;
}
