"use client";
/** Sign-up and sign-in forms. Both go through Better Auth's client, so the browser keeps only the httpOnly session cookie. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { authClient } from "@/auth/client";
import { defaultStudioName, newStudioSlug } from "@/auth/names";
import { emailInDomains, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, SIGN_UP_EMAIL_RULE } from "@/auth/rules";
import { BrandMark } from "../BrandMark";

const FIELD = "w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[14px] outline-none focus:border-[var(--primary)]";
export const BUTTON = "flex w-full items-center justify-center rounded-lg bg-[var(--primary-fill)] px-4 py-2.5 text-[13px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400";

export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters.`;
export const PASSWORD_LIMITS = { minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH };
export const SIGN_UP_EMAIL_HINT = "Gmail addresses only.";

// The forms set noValidate and check their own fields here, because the browser's built-in
// messages follow the browser's language rather than the app's.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailProblem = (email: string) => !email ? "Enter your email address." : EMAIL.test(email) ? null : "Enter a valid email address.";
export function signInProblem(email: string, password: string): string | null {
  return emailProblem(email) ?? (password ? null : "Enter your password.");
}
export function signUpProblem(name: string, email: string, password: string): string | null {
  if (!name) return "Enter your name.";
  return emailProblem(email) ?? (emailInDomains(email) ? null : SIGN_UP_EMAIL_RULE)
    ?? (password.length < PASSWORD_MIN_LENGTH ? `Use a password of at least ${PASSWORD_MIN_LENGTH} characters.` : null);
}

export function Shell({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return <main className="flex min-h-screen items-center justify-center px-4 py-10">
    <section className="w-full max-w-sm rounded-2xl border border-[var(--line)] bg-white p-6 shadow-sm">
      <p className="flex items-center gap-2 text-[14px] font-semibold tracking-tight text-[var(--ink)]"><BrandMark className="h-6 w-6" />Setti</p>
      <h1 className="mt-2 text-[22px] font-semibold tracking-tight">{title}</h1>
      <div className="mt-5">{children}</div>
      <p className="mt-5 text-[13px] text-[var(--muted)]">{footer}</p>
    </section>
  </main>;
}

export function Field({ label, hint, ...input }: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <label className="block text-[13px] font-medium">
    {label}
    <input {...input} className={`mt-1 ${FIELD}`} />
    {hint && <span className="mt-1 block text-[12px] font-normal text-[var(--muted)]">{hint}</span>}
  </label>;
}

export function useSubmit() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<string | null>) => {
    setBusy(true); setError(null);
    try { setError(await work()); } catch { setError("Something went wrong. Try again."); } finally { setBusy(false); }
  };
  return { error, busy, run };
}

export function SignUpForm() {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim(), studio = String(form.get("studio") ?? "").trim();
    const email = String(form.get("email") ?? "").trim(), password = String(form.get("password") ?? "");
    const problem = signUpProblem(name, email, password);
    void run(async () => {
      if (problem) return problem;
      const result = await authClient.signUp.email({ name, email, password });
      if (result.error) return result.error.message ?? "That account could not be created.";
      // A designer's account comes with the studio they run; it becomes the one they work in.
      const created = await authClient.organization.create({ name: studio || defaultStudioName(name), slug: newStudioSlug() });
      if (created.error) return "Your account was created, but its studio was not. Sign in to try again.";
      router.push("/chats");
      router.refresh();
      return null;
    });
  };
  return <Shell title="Create your studio" footer={<>Already have an account? <Link className="font-medium text-[var(--primary)]" href="/sign-in">Sign in</Link></>}>
    <form className="space-y-3" onSubmit={submit} noValidate>
      <Field label="Your name" name="name" autoComplete="name" required maxLength={100} />
      <Field label="Studio name" name="studio" autoComplete="organization" maxLength={100} hint="Optional. You can change it later." />
      <Field label="Email" name="email" type="email" autoComplete="email" required hint={SIGN_UP_EMAIL_HINT} />
      <Field label="Password" name="password" type="password" autoComplete="new-password" required {...PASSWORD_LIMITS} hint={PASSWORD_HINT} />
      {error && <p role="alert" className="text-[13px] text-red-700">{error}</p>}
      <button className={BUTTON} disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
    </form>
  </Shell>;
}

/** `next` is a path on this site, checked by the page. */
export function SignInForm({ next = "/chats" }: { next?: string }) {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim(), password = String(form.get("password") ?? "");
    const problem = signInProblem(email, password);
    void run(async () => {
      if (problem) return problem;
      const result = await authClient.signIn.email({ email, password });
      if (result.error) return result.error.status === 429 ? "Too many attempts. Wait a minute and try again." : "That email and password do not match an account.";
      router.push(next);
      router.refresh();
      return null;
    });
  };
  return <Shell title="Sign in" footer={<>New to Setti? <Link className="font-medium text-[var(--primary)]" href="/sign-up">Create a studio</Link></>}>
    <form className="space-y-3" onSubmit={submit} noValidate>
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required />
      {error && <p role="alert" className="text-[13px] text-red-700">{error}</p>}
      <button className={BUTTON} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  </Shell>;
}

export function SignOutButton() {
  const router = useRouter();
  const { busy, run } = useSubmit();
  return <button className={BUTTON} disabled={busy} onClick={() => void run(async () => {
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
    return null;
  })}>{busy ? "Signing out…" : "Sign out"}</button>;
}
