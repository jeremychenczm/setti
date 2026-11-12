import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireWorkspace } from "@/auth/viewer";
import { studioCase } from "@/demo/studio-cases";
import { Workspace } from "@/ui/workspace/Workspace";

export async function generateMetadata({ params }: { params: Promise<{ caseId: string }> }): Promise<Metadata> {
  return { title: `${studioCase((await params).caseId)?.name ?? "Project"} · Quotes | Setti`, robots: { index: false, follow: false } };
}

/** A project's quotes and payments: one of the viewer's projects, or one of the demo's prepared studio projects. */
export default async function ProjectQuotesPage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ tab?: string; v?: string }> }) {
  const key = (await params).caseId;
  const prepared = studioCase(key);
  const query = await searchParams;
  const tab = query.tab === "payments" ? "payments" : "quote";
  // ?v=2 opens version 2; without it the page opens on the draft being edited, else the newest version.
  const version = /^[1-9]\d{0,3}$/.test(query.v ?? "") ? Number(query.v) : null;
  const { account, demo, projects } = await requireWorkspace(`/quotes/${encodeURIComponent(key)}${tab === "payments" ? "?tab=payments" : version ? `?v=${version}` : ""}`, prepared ? undefined : key);
  const home = projects[0]?.key;
  if (prepared) {
    if (account.role !== "designer") redirect(home ? `/chats/${home}` : "/chats");
    return <Workspace account={account} demo={demo} projects={projects} initialView="quotes" initialPreparedCase={prepared.id} initialRecordsTab={tab} initialCase={home} initialQuote={home} />;
  }
  if (!projects.some((project) => project.key === key)) {
    if (account.role === "client" && home) redirect(`/quotes/${home}`);
    notFound();
  }
  return <Workspace account={account} demo={demo} projects={projects} initialView="quotes" initialRecordsTab={tab} initialCase={key} initialQuote={key} initialVersion={version} />;
}
