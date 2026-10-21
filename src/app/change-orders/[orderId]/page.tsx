import type { Metadata } from "next";
import { ChangeOrderPage } from "@/ui/pricing/ChangeOrderPage";

export const metadata: Metadata = { title: "Read-only client change order | Setti" };

export default async function ClientChangeOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return <ChangeOrderPage orderId={orderId} />;
}
