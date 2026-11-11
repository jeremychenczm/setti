import type { Metadata } from "next";
import { requireViewer } from "@/auth/viewer";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Willow Residence · Project chat | Setti" };

export default async function WillowChatPage() {
  const { account, demo } = await requireViewer("/chats/willow", "willow");
  return <Workspace account={account} demo={demo} initialView="chats" initialCase="willow" />;
}
