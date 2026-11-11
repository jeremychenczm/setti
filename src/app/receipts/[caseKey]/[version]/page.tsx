import type { Metadata } from "next";
import { requireWorkspace } from "@/auth/viewer";
import { ReceiptPage } from "@/ui/receipts/ReceiptPage";

export const metadata: Metadata = { title: "Signed version receipt | Setti", robots: { index: false, follow: false } };

/** A receipt carries PayPal ids, so only the project's people open it. */
export default async function SignedReceiptPage({ params }: { params: Promise<{ caseKey: string; version: string }> }) {
  const { caseKey, version } = await params;
  const { projects } = await requireWorkspace(`/receipts/${encodeURIComponent(caseKey)}/${encodeURIComponent(version)}`);
  return <ReceiptPage projectKey={caseKey} version={version} studioName={projects.find((project) => project.key === caseKey)?.studio ?? ""} />;
}
