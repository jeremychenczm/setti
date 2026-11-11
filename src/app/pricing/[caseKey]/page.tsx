import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireViewer } from "@/auth/viewer";
import { isCaseKey } from "@/chat/cases";
import { PricingWorkspaceView } from "@/ui/pricing/PricingWorkspaceView";
import { TryPageGuide } from "@/ui/try/TryPageGuide";

export const metadata: Metadata = { title: "Designer pricing review | Setti" };

/** The pricing review is the studio's work in progress; a client sees the change order once it is issued. */
export default async function PricingPage({ params }: { params: Promise<{ caseKey: string }> }) {
  const { caseKey } = await params;
  if (!isCaseKey(caseKey)) notFound();
  const { account, demo } = await requireViewer(`/pricing/${caseKey}`, caseKey);
  if (account.role !== "designer") redirect(`/chats/${caseKey}`);
  return <PricingWorkspaceView projectKey={caseKey} guide={demo ? <TryPageGuide projectKey={caseKey} account={account} currentView="pricing" /> : null} />;
}
