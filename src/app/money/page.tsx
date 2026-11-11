import type { Metadata } from "next";
import { requireViewer } from "@/auth/viewer";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Money | Setti", robots: { index: false, follow: false } };

/** The designer's money desk; a client lands on their own chat instead. */
export default async function MoneyPage() {
  const { account, demo } = await requireViewer("/money");
  return <Workspace account={account} demo={demo} initialView={account.role === "designer" ? "money" : "chats"} />;
}
