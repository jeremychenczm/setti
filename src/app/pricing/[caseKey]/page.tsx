import { notFound, redirect } from "next/navigation";
import { isCaseKey } from "@/chat/cases";

/** The quote editor moved into the project's Quotes; old links land there, and the browser keeps their #anchor. */
export default async function PricingPage({ params }: { params: Promise<{ caseKey: string }> }) {
  const { caseKey } = await params;
  if (!isCaseKey(caseKey)) notFound();
  redirect(`/quotes/${encodeURIComponent(caseKey)}`);
}
