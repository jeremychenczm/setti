import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentSession } from "@/auth/app";
import { SignUpForm } from "@/ui/account/AuthForm";

export const metadata: Metadata = { title: "Create your studio · Setti", robots: { index: false, follow: false } };

export default async function SignUpPage() {
  if (await currentSession()) redirect("/chats");
  return <SignUpForm />;
}
