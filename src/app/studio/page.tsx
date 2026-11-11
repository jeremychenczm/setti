import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/auth/viewer";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Studio projects | Setti", robots: { index: false, follow: false } };

/** The studio's projects, for its designers; a client lands on their own chat. */
export default async function StudioPage() {
  const { account, demo, projects } = await requireWorkspace("/studio");
  if (account.role !== "designer") redirect(projects[0] ? `/chats/${projects[0].key}` : "/chats");
  return <Workspace account={account} demo={demo} projects={projects} initialView="projects" />;
}
