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
  return appAuth().api.getSession({ headers: await headers() });
}

/** The signed-in user with the studio this request works in, or null when signed out. */
export async function currentAccount(): Promise<(NonNullable<Awaited<ReturnType<typeof currentSession>>> & { studio: ActiveStudio | null }) | null> {
  const session = await currentSession();
  if (!session) return null;
  return { ...session, studio: await activeStudio(appDb(), session.session) };
}
