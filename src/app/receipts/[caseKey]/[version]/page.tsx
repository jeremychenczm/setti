import type { Metadata } from "next";
import { ReceiptPage } from "@/ui/receipts/ReceiptPage";

export const metadata: Metadata = { title: "Signed version receipt | Setti", robots: { index: false, follow: false } };

export default async function SignedReceiptPage({ params }: { params: Promise<{ caseKey: string; version: string }> }) {
  const { caseKey, version } = await params;
  return <ReceiptPage projectKey={caseKey} version={version} />;
}
