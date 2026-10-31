import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { accountOrDefault } from "@/accounts/demo";
import { accountCookie } from "@/accounts/server";
import { STUDIO_CASES, studioCase } from "@/demo/studio-cases";
import { Workspace } from "@/ui/workspace/Workspace";

export const dynamicParams = false;
export function generateStaticParams() { return STUDIO_CASES.map((project) => ({ caseId: project.id })); }
export async function generateMetadata({ params }: { params: Promise<{ caseId: string }> }): Promise<Metadata> {
  return { title: `${studioCase((await params).caseId)?.name ?? "Project"} · Chat | Setti`, robots: { index: false, follow: false } };
}
export default async function StudioChatPage({ params }: { params: Promise<{ caseId: string }> }) {
  const project = studioCase((await params).caseId);
  if (!project) notFound();
  const account = accountOrDefault(await accountCookie());
  if (account.role !== "designer") redirect(`/chats/${account.projectKey}`);
  return <Workspace initialView="chats" initialPreparedCase={project.id} initialCase="maple" initialQuote="maple" initialAccount={account.id} />;
}
