import type { Metadata } from "next";
import { accountOrDefault } from "@/accounts/demo";
import { accountCookie } from "@/accounts/server";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Money | Setti", robots: { index: false, follow: false } };

/** The designer's money desk; a client account lands on its own chat instead. */
export default async function MoneyPage() {
  const account = accountOrDefault(await accountCookie());
  return <Workspace initialView={account.role === "designer" ? "money" : "chats"} initialAccount={account.id} />;
}
