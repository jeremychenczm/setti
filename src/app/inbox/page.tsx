import type { Metadata } from "next";
import { requireViewer } from "@/auth/viewer";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Inbox | Setti", robots: { index: false, follow: false } };

export default async function InboxPage() {
  const { account, demo } = await requireViewer("/inbox");
  return <Workspace account={account} demo={demo} initialView="inbox" />;
}
