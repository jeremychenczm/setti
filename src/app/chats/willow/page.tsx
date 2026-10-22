import type { Metadata } from "next";
import { accountCookie } from "@/accounts/server";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Willow Residence · Project chat | Setti" };

export default async function WillowChatPage() {
  return <Workspace initialView="chats" initialCase="willow" initialAccount={await accountCookie()} />;
}
