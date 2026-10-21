import type { Metadata } from "next";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Maple Ave · Project chat | Setti" };

export default function MapleChatPage() {
  return <Workspace initialView="chats" initialCase="maple" initialQuote="maple" />;
}
