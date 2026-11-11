/** Who a request is signed in as: the one call into Better Auth that API routes make. Tests mock this module. */
import { appAuth } from "@/auth/app";
import { appDb } from "@/db/shared";
import { actorFrom, type Actor } from "./identity";

export function requestActor(req: Request): Promise<Actor | null> {
  return actorFrom(appAuth(), appDb(), req.headers);
}
