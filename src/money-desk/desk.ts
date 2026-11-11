import { canOpenProject, type DemoAccount } from "@/accounts/demo";
import type { Db } from "@/db/client";
import { isRealStudio, projectKeys } from "@/projects/store";
import { exampleProjects } from "./examples";
import { liveProject } from "./live";
import type { DeskProject, MoneyDesk } from "./types";

/** Every project the designer runs: the studio's own projects, then, in a demo, the prepared examples. */
export async function moneyDesk(db: Db, sessionId: string | null, account: DemoAccount, now = new Date()): Promise<MoneyDesk> {
  if (account.role !== "designer") throw new Error("Only the designer sees the money desk.");
  const live: DeskProject[] = [];
  if (sessionId) {
    for (const key of await projectKeys(db, sessionId)) {
      if (!canOpenProject(account, key)) continue;
      const project = await liveProject(db, sessionId, key, account, now);
      if (project) live.push(project);
    }
  }
  const real = !!sessionId && await isRealStudio(db, sessionId);
  return { checkedAt: now.toISOString(), projects: real ? live : [...live, ...exampleProjects()] };
}
