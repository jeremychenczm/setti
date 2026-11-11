import type { Metadata } from "next";
import { requireWorkspace } from "@/auth/viewer";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Inbox | Setti", robots: { index: false, follow: false } };

export default async function InboxPage() {
  const { account, demo, projects } = await requireWorkspace("/inbox");
  return <Workspace account={account} demo={demo} projects={projects} initialView="inbox" />;
}
