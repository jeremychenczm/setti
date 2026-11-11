import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/auth/viewer";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Studio projects | Setti", robots: { index: false, follow: false } };

/** The demo's prepared studio projects, for its designer; anyone else lands on their chats. */
export default async function StudioPage() {
  const { account, demo, projects } = await requireWorkspace("/studio");
  if (account.role !== "designer" || !demo) redirect(projects[0] ? `/chats/${projects[0].key}` : "/chats");
  return <Workspace account={account} demo={demo} projects={projects} initialView="projects" />;
}
