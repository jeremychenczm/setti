import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentSession } from "@/auth/app";
import { SignInForm } from "@/ui/account/AuthForm";

export const metadata: Metadata = { title: "Sign in · Setti", robots: { index: false, follow: false } };

export default async function SignInPage() {
  if (await currentSession()) redirect("/account");
  return <SignInForm />;
}
