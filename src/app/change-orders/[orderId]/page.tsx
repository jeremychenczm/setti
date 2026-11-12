import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { studios } from "@/auth/schema";
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
  // The project's people read and act on a version in its Quotes; the browser keeps the link's #anchor. A shared link stays a read-only page.
  if (account && owner) redirect(`/quotes/${encodeURIComponent(owner.key)}?v=${owner.version}`);
  // The project's people see the version's formal quote, which names the studio.
  const [studio] = account && owner ? await appDb().select({ name: studios.name }).from(studios).where(eq(studios.id, owner.studioId)) : [];
  return <ChangeOrderPage orderId={orderId} account={account} demo={!!account && actor?.demoPersona != null} studioName={studio?.name ?? ""} />;
}
