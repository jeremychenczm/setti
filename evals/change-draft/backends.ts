/**
 * Where a change-draft eval gets its model answers. Every backend is plugged in
 * as Setti's own callModel dependency, so the server's checks and its one
 * rewrite run exactly as in production.
 */
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { CHANGE_SYSTEM_PROMPT, DEFAULT_MODEL, EFFORT, callChangeModel, changeModelOutputSchema, contextParts, modelContext, type ChangeModelInput, type ChangeModelOutput } from "@/ai/model";
import { runHeadless } from "../lib/claude-code";
import { fingerprint, type Replayer } from "../lib/replay";
import type { DraftCase } from "./cases";
import type { Attempt } from "./grade";

export type BackendName = "claude-code" | "api" | "oracle" | "null" | "replay";
type CallModel = typeof callChangeModel;

/** Sonnet 5.5 list prices per million tokens, for the api backend's cost column. */
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

function userText(input: ChangeModelInput): string {
  const { quote, request, retry } = contextParts(input);
  return [JSON.stringify(quote), JSON.stringify(request), ...(retry ? [JSON.stringify(retry)] : [])].join("\n\n");
}

const CHANGE_SCHEMA = betaZodOutputFormat(changeModelOutputSchema).schema;

/**
 * Everything that decides the model's answer to one change-model call. A page's
 * fetchedAt is left out: it is when the page was read, so it differs on every run
 * while the page itself does not.
 */
export function changeFingerprint(input: ChangeModelInput): string {
  const parts = contextParts(input);
  const request = { ...parts.request, productPages: parts.request.productPages.map((page) => ({ ...page, fetchedAt: undefined })) };
  return fingerprint("change", process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL, EFFORT, CHANGE_SYSTEM_PROMPT, CHANGE_SCHEMA, { ...parts, request });
}

/** A model answer built from the answer key: should pass every case. */
function oracleOutput(testCase: DraftCase, input: ChangeModelInput): ChangeModelOutput {
  const expected = testCase.expected;
  const base = { title: "", unresolved: [], constraints: [], money: null };
  if (expected.outcome === "cancel") return { ...base, intent: "cancel", message: "I withdrew the current draft; V1 stays as signed.", changes: [] };
  if (expected.outcome === "no_draft") return { ...base, intent: expected.intents?.[0] ?? "clarify", message: expected.reference ?? "Could you tell me which item you mean?", changes: [] };
  return {
    ...base, intent: "draft", title: "Revised quote draft", message: expected.reference ?? "I drafted the requested changes for your review. Please check the prices and terms.",
    changes: (expected.changes ?? []).map((change) => ({
      action: change.action, itemId: change.itemId, quantity: change.action === "remove" ? null : change.quantity ?? null,
      productOptionId: change.productOptionId ?? null, description: `Requested ${change.action}.`, sourceMessageIds: [input.triggerId],
    })),
  };
}

/** A model that never does the work: every draft case should fail. */
const NULL_OUTPUT: ChangeModelOutput = { intent: "answer", message: "I can help with that.", title: "", changes: [], unresolved: [], constraints: [], money: null };

export function backend(name: BackendName, testCase: DraftCase, recordAttempt: (attempt: Attempt) => void, options: { timeoutMs: number; contextLimit: number; replay?: Replayer }): CallModel {
  let n = 0;
  return async (input) => {
    n += 1;
    const problems = input.previousAttemptProblems?.length ? input.previousAttemptProblems : null;
    const started = Date.now();
    const requestFingerprint = changeFingerprint(input);
    const record = (attempt: Omit<Attempt, "fingerprint">) => recordAttempt({ ...attempt, fingerprint: requestFingerprint });
    if (name === "replay") {
      modelContext(input, options.contextLimit);
      const output = changeModelOutputSchema.parse(options.replay!.answer(requestFingerprint)) as ChangeModelOutput;
      record({ n, problems, kind: "ok", output, model: "replay", usage: null, costUsd: 0, durationMs: Date.now() - started });
      return { output, model: "replay" };
    }
    if (name === "oracle" || name === "null") {
      modelContext(input, options.contextLimit);
      const output = name === "oracle" ? oracleOutput(testCase, input) : NULL_OUTPUT;
      record({ n, problems, kind: "ok", output, model: name, usage: null, costUsd: 0, durationMs: Date.now() - started });
      return { output, model: name };
    }
    if (name === "api") {
      try {
        const result = await callChangeModel(input);
        const usage = result.usage ?? null;
        const costUsd = usage ? (usage.inputTokens * PRICE.input + usage.outputTokens * PRICE.output + usage.cacheReadTokens * PRICE.cacheRead + usage.cacheWriteTokens * PRICE.cacheWrite) / 1e6 : 0;
        record({ n, problems, kind: "ok", output: result.output, model: result.model, usage, costUsd, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        if (!(error instanceof Error && /^This project's context exceeds/u.test(error.message))) {
          record({ n, problems, kind: "error", output: null, model: null, usage: null, costUsd: 0, durationMs: Date.now() - started, message: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
        }
        throw error;
      }
    }
    // claude-code: the same prompt, schema, model and effort through Claude Code's headless mode.
    modelContext(input, options.contextLimit);
    const result = await runHeadless({
      model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL, effort: EFFORT, system: CHANGE_SYSTEM_PROMPT,
      user: userText(input), schema: betaZodOutputFormat(changeModelOutputSchema).schema, timeoutMs: options.timeoutMs,
    });
    if (result.kind !== "ok") {
      record({ n, problems, kind: result.kind, output: null, model: result.model, usage: result.usage, costUsd: result.costUsd, durationMs: result.durationMs, message: result.message });
      throw new Error(`The model did not return a complete, valid result. Retry. (${result.kind}: ${result.message.slice(0, 120)})`);
    }
    const parsed = changeModelOutputSchema.safeParse(result.json);
    record({ n, problems, kind: parsed.success ? "ok" : "error", output: result.json, model: result.model, usage: result.usage, costUsd: result.costUsd, durationMs: result.durationMs, message: parsed.success ? undefined : parsed.error.message.slice(0, 300) });
    if (!parsed.success) throw new Error("The model did not return a complete, valid result. Retry.");
    return { output: parsed.data as ChangeModelOutput, model: result.model, usage: result.usage };
  };
}
