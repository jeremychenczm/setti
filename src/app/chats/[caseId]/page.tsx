import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireWorkspace } from "@/auth/viewer";
import { studioCase } from "@/demo/studio-cases";
import { Workspace } from "@/ui/workspace/Workspace";

export async function generateMetadata({ params }: { params: Promise<{ caseId: string }> }): Promise<Metadata> {
  return { title: `${studioCase((await params).caseId)?.name ?? "Project"} · Chat | Setti`, robots: { index: false, follow: false } };
}

/** A project's chat: one of the viewer's projects, or one of the demo's prepared studio projects. */
export default async function ProjectChatPage({ params }: { params: Promise<{ caseId: string }> }) {
  const key = (await params).caseId;
  const prepared = studioCase(key);
  const { account, demo, projects } = await requireWorkspace(`/chats/${encodeURIComponent(key)}`, prepared ? undefined : key);
  const home = projects[0]?.key;
  if (prepared) {
    if (account.role !== "designer") redirect(home ? `/chats/${home}` : "/chats");
    return <Workspace account={account} demo={demo} projects={projects} initialView="chats" initialPreparedCase={prepared.id} initialCase={home} initialQuote={home} />;
  }
  if (!projects.some((project) => project.key === key)) {
    if (account.role === "client" && home) redirect(`/chats/${home}`);
    notFound();
  }
  return <Workspace account={account} demo={demo} projects={projects} initialView="chats" initialCase={key} initialQuote={key} />;
}
