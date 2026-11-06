/**
 * Captures money evidence from real local walkthrough sessions, read-only,
 * through Setti's own readCaseMoneyContext, so money-answer cases rest on
 * records that real Sandbox payments produced. Writes evals/money-answer/fixtures/<name>.json.
 *
 *   npx tsx evals/money-answer/capture.ts <name>=<session id> [...]   (uses DATABASE_URL from .env.local)
 *   npx tsx evals/money-answer/capture.ts --list <session id> [...]    (prints the facts without writing)
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCaseMoneyContext } from "@/ai/money-context";
import { createChatStore } from "@/chat/store";
import { createDb } from "@/db/client";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const args = process.argv.slice(2);
const list = args[0] === "--list";
const targets = (list ? args.slice(1) : args).map((arg) => list ? ["", arg] : arg.split("="));
const { db, pool } = createDb(process.env.DATABASE_URL!);

async function main() {
  const out = join(process.cwd(), "evals", "money-answer", "fixtures");
  mkdirSync(out, { recursive: true });
  for (const [name, session] of targets) {
    const context = await readCaseMoneyContext(db, session, "maple");
    const state = await createChatStore(db).getCase(session, "maple");
    if (list) {
      console.log(`\n=== ${session} · quote ${state.quote?.id} v${state.quote?.version} · ${context.facts.length} facts · mandatory ${JSON.stringify(context.mandatoryFactIds ?? [])}`);
      for (const fact of context.facts) console.log(`  ${fact.id.padEnd(34)} ${fact.text.en.slice(0, 170)}`);
      continue;
    }
    // Only what the model and the checks read: no session, message history or browser identity.
    writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ capturedAt: new Date().toISOString(), quote: state.quote, moneyContext: { ...context, projectKey: "maple" } }, null, 2)}\n`);
    console.log(`wrote ${name}.json · ${context.facts.length} facts`);
  }
  await pool.end();
}

void main();
