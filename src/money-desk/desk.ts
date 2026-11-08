import { canOpenProject, type DemoAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import type { Db } from "@/db/client";
import { exampleProjects } from "./examples";
import { liveProject } from "./live";
import type { DeskProject, MoneyDesk } from "./types";

const LIVE: readonly CaseKey[] = ["maple", "willow"];

/** Every project the designer runs: this session's live projects first, then the prepared examples. */
export async function moneyDesk(db: Db, sessionId: string | null, account: DemoAccount, now = new Date()): Promise<MoneyDesk> {
  if (account.role !== "designer") throw new Error("Only the designer sees the money desk.");
  const live: DeskProject[] = [];
  if (sessionId) {
    for (const key of LIVE) {
      if (!canOpenProject(account, key)) continue;
      const project = await liveProject(db, sessionId, key, account, now);
      if (project) live.push(project);
    }
  }
  return { checkedAt: now.toISOString(), projects: [...live, ...exampleProjects()] };
}
