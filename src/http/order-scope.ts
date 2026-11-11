/**
 * Who a request is on one change order: a change order's id is a share link, so
 * anyone may read it, and only the people in its project act on it.
 */
import type { DemoAccount } from "@/accounts/demo";
import { appDb } from "@/db/shared";
import { changeOrderOwner, type ChangeOrderOwner } from "@/pricing/owner";
import { requestActor } from "./actor";
import { projectAccess, type Actor } from "./identity";

export interface OrderScope {
  /** Null when signed out. */
  actor: Actor | null;
  /** Null when the change order does not exist. */
  owner: ChangeOrderOwner | null;
  /** Who the actor is in the order's project; null when signed out or outside it. */
  account: DemoAccount | null;
}

export async function orderScope(req: Request, id: string): Promise<OrderScope> {
  const actor = await requestActor(req);
  if (!actor) return { actor: null, owner: null, account: null };
  const owner = await changeOrderOwner(appDb(), id);
  return { actor, owner, account: owner && projectAccess(actor, owner) };
}
