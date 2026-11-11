import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentSession } from "@/auth/app";
import { safeNextPath } from "@/http/next-path";
import { SignInForm } from "@/ui/account/AuthForm";

export const metadata: Metadata = { title: "Sign in · Setti", robots: { index: false, follow: false } };

/** After signing in, the visitor goes back to the page that asked them to (`?next=`), or to their projects. */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const requested = (await searchParams).next;
  const next = safeNextPath(typeof requested === "string" ? requested : null) ?? "/chats";
  if (await currentSession()) redirect(next);
  return <SignInForm next={next} />;
}
