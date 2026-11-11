import type { Metadata } from "next";
import { requireViewer } from "@/auth/viewer";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Maple Ave Café · Project chat | Setti" };

export default async function MapleChatPage() {
  const { account, demo } = await requireViewer("/chats/maple", "maple");
  return <Workspace account={account} demo={demo} initialView="chats" initialCase="maple" initialQuote="maple" />;
}
