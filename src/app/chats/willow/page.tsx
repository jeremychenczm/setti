import type { Metadata } from "next";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Willow Residence · Project chat | Setti" };

export default function WillowChatPage() {
  return <Workspace initialView="chats" initialCase="willow" />;
}
