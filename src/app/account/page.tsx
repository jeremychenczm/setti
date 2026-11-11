import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAccount } from "@/auth/app";
import { SignOutButton } from "@/ui/account/AuthForm";

export const metadata: Metadata = { title: "Your account · Setti", robots: { index: false, follow: false } };

const ROLE = { owner: "Owner", admin: "Admin", member: "Designer" } as Record<string, string>;

export default async function AccountPage() {
  const session = await currentAccount();
  if (!session) redirect("/sign-in");
  const { studio } = session;
  return <main className="flex min-h-screen items-center justify-center px-4 py-10">
    <section className="w-full max-w-sm rounded-2xl border border-[var(--line)] bg-white p-6 shadow-sm">
      <p className="text-[13px] font-semibold tracking-tight text-[var(--primary)]">setti.</p>
      <h1 className="mt-2 text-[22px] font-semibold tracking-tight">{session.user.name}</h1>
      <p className="text-[13px] text-[var(--muted)]">{session.user.email}</p>
      <dl className="mt-5 space-y-2 text-[13px]">
        <div className="flex justify-between gap-4"><dt className="text-[var(--muted)]">Studio</dt><dd className="font-medium">{studio?.name ?? "None"}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-[var(--muted)]">Role</dt><dd className="font-medium">{studio ? ROLE[studio.role] ?? studio.role : "—"}</dd></div>
      </dl>
      <div className="mt-6"><SignOutButton /></div>
    </section>
  </main>;
}
