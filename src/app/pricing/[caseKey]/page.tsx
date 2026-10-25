import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isCaseKey } from "@/chat/cases";
import { PricingWorkspaceView } from "@/ui/pricing/PricingWorkspaceView";
import { accountCookie } from "@/accounts/server";
import { TryPageGuide } from "@/ui/try/TryPageGuide";

export const metadata: Metadata = { title: "Designer pricing review | Setti" };

export default async function PricingPage({ params }: { params: Promise<{ caseKey: string }> }) {
  const { caseKey } = await params;
  if (!isCaseKey(caseKey)) notFound();
  return <><div className="bg-[var(--canvas)] px-3 pt-3 sm:px-6"><div className="mx-auto max-w-[1440px]"><TryPageGuide projectKey={caseKey} account={await accountCookie()} currentView="pricing" /></div></div><PricingWorkspaceView projectKey={caseKey} /></>;
}
