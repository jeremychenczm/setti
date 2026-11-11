import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/auth/viewer";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Chats | Setti", robots: { index: false, follow: false } };

/** Where a signed-in account starts: its first project's chat, or an empty studio's first project. */
export default async function ChatsPage() {
  const { account, demo, projects } = await requireWorkspace("/chats");
  if (projects[0]) redirect(`/chats/${projects[0].key}`);
  return <Workspace account={account} demo={demo} projects={projects} initialView="chats" />;
}
