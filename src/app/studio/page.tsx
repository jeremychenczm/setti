import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireViewer } from "@/auth/viewer";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Studio projects | Setti", robots: { index: false, follow: false } };

/** The studio's projects, for its designers; a client lands on their own chat. */
export default async function StudioPage() {
  const { account, demo } = await requireViewer("/studio");
  if (account.role !== "designer") redirect(account.projectKey ? `/chats/${account.projectKey}` : "/account");
  return <Workspace account={account} demo={demo} initialView="projects" initialCase="maple" initialQuote="maple" />;
}
