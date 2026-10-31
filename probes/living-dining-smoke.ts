/** Explicit local smoke check: prepares real Sandbox holds and calls the configured AI. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HOME_DESIGNER_REQUEST, HOME_DISCUSSION, HOME_ITEM_IDS, HOME_SCENARIO, HOME_SUPPLIER_NOTES } from "../src/demo/living-dining";
import { createPricingInput, previewPricing } from "../src/pricing/calculation";
import type { CaseSnapshot } from "../src/chat/types";
import type { PricingWorkspace } from "../src/pricing/types";

const base = new URL(process.argv[2] || "http://localhost:3002");
if (!["localhost", "127.0.0.1"].includes(base.hostname) || base.protocol !== "http:") throw new Error("This check only targets a local development server.");
const cookies = new Map([["setti-demo-account", "jordan"]]);
async function request<T>(route: string, body?: object): Promise<T> {
  const response = await fetch(new URL(route, base), {
    method: body ? "POST" : "GET", headers: { Origin: base.origin, "Content-Type": "application/json", Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(150_000),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0], split = pair.indexOf("=");
    if (/max-age=0(?:;|$)/iu.test(cookie)) cookies.delete(pair.slice(0, split));
    else cookies.set(pair.slice(0, split), pair.slice(split + 1));
  }
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${result.error || "request failed"}`);
  return result as T;
}
type State = { seed: { runId: string; status: string; scenario: string; workspaceReady: boolean; baselineQuoteVersion: number; changeOrderId: string | null; stages: { id: string; label: string; status: string }[] } | null; previousRuns: unknown[] };

async function main() {
  const openingStarted = performance.now();
  let state = await request<State>("/api/try", { action: "start", scenario: HOME_SCENARIO });
  assert(state.seed);
  const workspaceOpenMs = Math.round(performance.now() - openingStarted);
  assert.equal(state.seed?.scenario, HOME_SCENARIO);
  assert.equal(state.seed?.workspaceReady, true, "The case must open before PayPal preparation");
  assert.equal(state.seed?.baselineQuoteVersion, 1);
  assert.equal(state.seed?.changeOrderId, null, "The approved V1 is not a change order");
  assert.equal(state.seed?.status, "seeding");
  assert.deepEqual(state.seed.stages.filter((stage) => stage.status === "done").map((stage) => stage.id).sort(), ["discussion", "quote"]);
  const initial = await request<CaseSnapshot>("/api/chat/maple");
  assert.equal(initial.quote?.version, 1);
  assert.equal(initial.draft, null);
  assert.equal(initial.versions?.length, 0, "No artificial V2 may precede the real discussion");
  assert.deepEqual(initial.messages.filter((message) => message.model === "demo-scenario-discussion").map(({ actor, text }) => ({ actor, text })), HOME_DISCUSSION);
  assert.equal(initial.messages.find((message) => message.model === "demo-supplier-notes")?.text, HOME_SUPPLIER_NOTES);
  console.log(`V1 and the full conversation opened in ${workspaceOpenMs}ms, before any PayPal stage.`);
  for (let attempt = 0; state.seed?.status !== "ready" && attempt < 60; attempt++) {
    state = await request<State>("/api/try", { action: "prepare", runId: state.seed!.runId });
    console.log(`Preparation: ${state.seed!.stages.filter((stage) => stage.status === "done").length}/${state.seed!.stages.length} stages saved`);
    if (state.seed?.status !== "ready") await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(state.seed?.status, "ready");
  assert(state.seed);
  assert.equal(state.seed.changeOrderId, null);
  console.log("Prepared discussion and source documents are saved in order; requesting the real model.");
  const result = await request<CaseSnapshot>("/api/chat/maple", { id: randomUUID(), actor: "designer", text: HOME_DESIGNER_REQUEST });
  assert(result.draft, "The model must produce a designer-review draft");
  assert.equal(result.draft.origin, "designer");
  assert.deepEqual(result.draft.changes.map((change) => change.itemId).sort(), [...HOME_ITEM_IDS].sort());
  assert.equal(result.draft.basedOnVersion, 1);
  assert.equal(result.versions?.length, 0, "AI must not issue or approve a client version");
  const workspace = await request<PricingWorkspace>("/api/pricing/maple");
  assert(workspace.sourceDraft);
  const input = createPricingInput(workspace.quote, workspace.sourceDraft);
  const preview = previewPricing(workspace.quote, workspace.sourceDraft, input);
  assert.equal(preview.baselineTotals.totalCents, 773_000);
  assert.equal(preview.proposedTotals?.totalCents, 567_000);
  assert.equal(preview.deltaTotalCents, -206_000);
  assert(input.changes.every((change) => !change.confirmed), "Every row must await designer confirmation");
  assert(input.issues.every((issue) => !issue.resolved), "No review issue may be automatically resolved");
  assert.equal(preview.ready, false);
  const summary = {
    checkedAt: new Date().toISOString(), scenario: HOME_SCENARIO, discussionMessages: HOME_DISCUSSION.length,
    model: result.draft.model, origin: result.draft.origin, quoteVersion: workspace.quote.version, workspaceOpenMs,
    changes: result.draft.changes.map(({ action, itemId, after, productOptionId }) => ({ action, itemId, quantity: after?.quantity ?? null, productOptionId })),
    baselineCents: preview.baselineTotals.totalCents, proposedCents: preview.proposedTotals!.totalCents, differenceCents: preview.deltaTotalCents,
    reviewRequired: !preview.ready, formalNewVersionIssued: false,
  };
  await request("/api/try", { action: "end" });
  const reset = await request<State>("/api/try");
  assert.equal(reset.seed, null);
  assert.deepEqual(reset.previousRuns, []);
  const output = path.join("probes", "recorded");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `living-dining-smoke-${summary.checkedAt.slice(0, 10)}.json`), JSON.stringify({ ...summary, resetVerified: true }, null, 2) + "\n");
  console.log(JSON.stringify({ ...summary, resetVerified: true }, null, 2));
}

main().catch(async (error) => {
  await request("/api/try", { action: "end" }).catch(() => {});
  console.error(error instanceof Error ? error.message : "The local smoke check failed.");
  process.exitCode = 1;
});
