"use client";
/**
 * The page a client's invite link opens: who is inviting them to what, and a
 * way in. Signed out, they create a client account (no studio) or sign in;
 * signed in as a client, they join; a studio's account is asked to sign out.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { authClient } from "@/auth/client";
import { BUTTON, Field, PASSWORD_HINT, Shell, useSubmit } from "./AuthForm";

interface Invite {
  status: "open" | "expired" | "used" | "replaced";
  projectName: string;
  studioName: string;
  designerName: string;
}

interface Viewer {
  name: string;
  email: string;
  kind: "client" | "studio" | "demo";
}

const CLOSED: Record<Exclude<Invite["status"], "open">, string> = {
  expired: "This invite link has expired.",
  used: "This invite link has already been used.",
  replaced: "A newer invite link replaced this one.",
};

/** Joins the project and opens its chat; returns the reason when it cannot. */
async function join(token: string): Promise<string | null> {
  const response = await fetch("/api/invites/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  const body = await response.json().catch(() => null) as { href?: string; error?: string } | null;
  if (!response.ok || !body?.href) return body?.error ?? "You could not join the project. Try again.";
  window.location.assign(body.href);
  return null;
}

function SignOut({ label }: { label: string }) {
  const router = useRouter();
  const { busy, run } = useSubmit();
  return <button className={BUTTON} disabled={busy} onClick={() => void run(async () => { await authClient.signOut(); router.refresh(); return null; })}>{busy ? "Signing out…" : label}</button>;
}

export function InviteJoin({ token, invite, viewer }: { token: string; invite: Invite | null; viewer: Viewer | null }) {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  const here = `/invite/${token}`;

  if (!invite || invite.status !== "open") {
    return <Shell title={invite && invite.status !== "open" ? CLOSED[invite.status] : "This invite link does not work"} footer={<Link className="font-medium text-[var(--primary)]" href={viewer ? "/chats" : "/sign-in"}>{viewer ? "Go to your projects" : "Sign in"}</Link>}>
      <p className="text-[14px] leading-relaxed text-slate-600">{invite ? `Ask ${invite.designerName} at ${invite.studioName} to send you a new link for ${invite.projectName}.` : "Check that the whole link was copied, or ask your designer for a new one."}</p>
    </Shell>;
  }

  const intro = <p className="text-[14px] leading-relaxed text-slate-600"><strong className="font-medium text-slate-900">{invite.designerName}</strong> at {invite.studioName} invited you to <strong className="font-medium text-slate-900">{invite.projectName}</strong>. You will see its quote, chat with the studio and approve changes there.</p>;
  const alert = error && <p role="alert" className="text-[13px] text-red-700">{error}</p>;

  if (viewer?.kind === "client") {
    return <Shell title="Join the project" footer={<>Signed in as {viewer.email}. Not you? <SignOutLink /></>}>
      <div className="space-y-4">{intro}{alert}<button className={BUTTON} disabled={busy} onClick={() => void run(() => join(token))}>{busy ? "Joining…" : "Join the project"}</button></div>
    </Shell>;
  }

  if (viewer) {
    return <Shell title="Join the project" footer={<>Signed in as {viewer.email}.</>}>
      <div className="space-y-4">{intro}
        <p className="text-[13px] leading-relaxed text-slate-600">{viewer.kind === "studio" ? "This account runs a studio, so it cannot join as the client. Sign out, then join with a client account." : "This is a demo account. Sign out, then join with your own account."}</p>
        <SignOut label="Sign out" />
      </div>
    </Shell>;
  }

  const signUp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      // A client's account has no studio: it opens only the projects it joins.
      const result = await authClient.signUp.email({ name: String(form.get("name") ?? "").trim(), email: String(form.get("email") ?? "").trim(), password: String(form.get("password") ?? "") });
      if (result.error) return result.error.message ?? "That account could not be created.";
      const refused = await join(token);
      // The new account is signed in either way; show the page as that account sees it.
      if (refused) router.refresh();
      return refused;
    });
  };
  return <Shell title="Join the project" footer={<>Already have an account? <Link className="font-medium text-[var(--primary)]" href={`/sign-in?next=${encodeURIComponent(here)}`}>Sign in</Link></>}>
    <div className="space-y-4">{intro}
      <form className="space-y-3" onSubmit={signUp}>
        <Field label="Your name" name="name" autoComplete="name" required maxLength={100} />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} hint={PASSWORD_HINT} />
        {alert}
        <button className={BUTTON} disabled={busy}>{busy ? "Joining…" : "Create account and join"}</button>
      </form>
    </div>
  </Shell>;
}

function SignOutLink() {
  const router = useRouter();
  return <button className="font-medium text-[var(--primary)]" onClick={() => void authClient.signOut().then(() => router.refresh())}>Sign out</button>;
}
