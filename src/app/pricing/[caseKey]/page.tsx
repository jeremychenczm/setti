import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isCaseKey } from "@/chat/cases";
import { PricingWorkspaceView } from "@/ui/pricing/PricingWorkspaceView";

export const metadata: Metadata = { title: "Designer pricing review | Setti" };

export default async function PricingPage({ params }: { params: Promise<{ caseKey: string }> }) {
  const { caseKey } = await params;
  if (!isCaseKey(caseKey)) notFound();
  return <PricingWorkspaceView projectKey={caseKey} />;
}
