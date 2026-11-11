import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireWorkspace } from "@/auth/viewer";
import { isCaseKey } from "@/chat/cases";
import { PricingWorkspaceView } from "@/ui/pricing/PricingWorkspaceView";
import { TryPageGuide } from "@/ui/try/TryPageGuide";

export const metadata: Metadata = { title: "Designer pricing review | Setti" };

/** The pricing review is the studio's work in progress; a client sees the change order once it is issued. */
export default async function PricingPage({ params }: { params: Promise<{ caseKey: string }> }) {
  const { caseKey } = await params;
  if (!isCaseKey(caseKey)) notFound();
  const { account, demo, projects } = await requireWorkspace(`/pricing/${caseKey}`, caseKey);
  if (account.role !== "designer") redirect(`/chats/${caseKey}`);
  const project = projects.find((entry) => entry.key === caseKey);
  if (!project) notFound();
  return <PricingWorkspaceView projectKey={caseKey} clientName={project.client?.name ?? "the client"} guide={demo ? <TryPageGuide projectKey={caseKey} account={account} currentView="pricing" /> : null} />;
}
