/** The app's one Better Auth instance, on the shared database pool. */
import { headers } from "next/headers";
import { appDb } from "@/db/shared";
import { createAuth, type Auth } from "./server";
import { activeStudio, type ActiveStudio } from "./studio";

const shared = globalThis as typeof globalThis & { settiAuth?: Auth };

export { appDb };

export function appAuth(): Auth {
  shared.settiAuth ??= createAuth(appDb());
  return shared.settiAuth;
}

/** The signed-in user and session for the current request, or null. */
export async function currentSession() {
  // The request's headers first: they make the page dynamic, so a build never opens the database for it.
  const requestHeaders = await headers();
  return appAuth().api.getSession({ headers: requestHeaders });
}

/** The signed-in user with the studio this request works in, or null when signed out. */
export async function currentAccount(): Promise<(NonNullable<Awaited<ReturnType<typeof currentSession>>> & { studio: ActiveStudio | null }) | null> {
  const session = await currentSession();
  if (!session) return null;
  return { ...session, studio: await activeStudio(appDb(), session.session) };
}
