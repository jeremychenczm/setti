import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { STUDIO_CASES, studioCase } from "@/demo/studio-cases";

export const dynamicParams = false;
export function generateStaticParams() { return STUDIO_CASES.map((project) => ({ caseId: project.id })); }
export async function generateMetadata({ params }: { params: Promise<{ caseId: string }> }): Promise<Metadata> {
  const project = studioCase((await params).caseId);
  return { title: `${project?.name ?? "Project"} | Setti studio`, robots: { index: false, follow: false } };
}
export default async function StudioProjectPage({ params }: { params: Promise<{ caseId: string }> }) {
  const project = studioCase((await params).caseId);
  if (!project) notFound();
  redirect(`/chats/${project.id}`);
}
