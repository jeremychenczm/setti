import type { Metadata } from "next";
import { requireWorkspace } from "@/auth/viewer";
import { ReceiptPage } from "@/ui/receipts/ReceiptPage";
import { DemoModeProvider } from "@/ui/demo-mode";

export const metadata: Metadata = { title: "Formal quote and receipt | Setti", robots: { index: false, follow: false } };

/** A version's formal document: its quote before the client signs, its signed receipt after. It carries PayPal ids, so only the project's people open it. */
export default async function SignedReceiptPage({ params }: { params: Promise<{ caseKey: string; version: string }> }) {
  const { caseKey, version } = await params;
  const { projects, demo } = await requireWorkspace(`/receipts/${encodeURIComponent(caseKey)}/${encodeURIComponent(version)}`);
  return <DemoModeProvider value={demo}><ReceiptPage projectKey={caseKey} version={version} studioName={projects.find((project) => project.key === caseKey)?.studio ?? ""} /></DemoModeProvider>;
}
