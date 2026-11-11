import type { Metadata } from "next";
import { currentActor } from "@/auth/viewer";
import { appDb } from "@/db/shared";
import { projectAccess } from "@/http/identity";
import { changeOrderOwner } from "@/pricing/owner";
import { ChangeOrderPage } from "@/ui/pricing/ChangeOrderPage";

export const metadata: Metadata = { title: "Read-only client change order | Setti" };

/** A change order's link is shared: anyone reads it, and the project's people act on it once signed in. */
export default async function ClientChangeOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const actor = await currentActor();
  const owner = actor ? await changeOrderOwner(appDb(), orderId) : null;
  const account = actor && owner ? projectAccess(actor, owner) : null;
  return <ChangeOrderPage orderId={orderId} account={account} demo={!!account && actor?.demoPersona != null} />;
}
