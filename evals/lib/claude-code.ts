/**
 * Runs one model request through Claude Code's headless mode (`claude -p`) on
 * the developer's own Claude Code login, so an eval can run without an API key.
 *
 * It keeps what decides the answer: the same model, Setti's own system prompt
 * (replacing Claude Code's), no tools, the same effort and the same JSON schema.
 * What differs from production, and is reported with every result:
 * - Claude Code attaches one short context block (the signed-in account);
 * - the schema is enforced by Claude Code's structured output, not the API's output_config;
 * - there is no server-side fallback model, so a safety refusal ends the attempt.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface HeadlessRequest {
  model: string;
  effort: string;
  system: string;
  user: string;
  schema: object;
  timeoutMs: number;
}

export interface HeadlessUsage { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }

export type HeadlessResult =
  | { kind: "ok"; json: unknown; model: string; usage: HeadlessUsage; costUsd: number; durationMs: number }
  | { kind: "refusal" | "error" | "timeout"; message: string; model: string | null; usage: HeadlessUsage | null; costUsd: number; durationMs: number };

/** A neutral working directory, so no project instructions sit beside the request. */
function neutralDirectory(): string {
  const directory = join(tmpdir(), "setti-eval-headless");
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** The child must use the Claude Code login, never an API key from the developer's shell or .env files. */
function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[name];
  return env;
}

interface PrintOutput {
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
  total_cost_usd?: number;
}

export function runHeadless(request: HeadlessRequest): Promise<HeadlessResult> {
  const args = [
    "-p", "--model", request.model, "--effort", request.effort,
    "--system-prompt", request.system,
    "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
    "--json-schema", JSON.stringify(request.schema), "--output-format", "json",
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: neutralDirectory(), env: childEnvironment(), windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: HeadlessResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => {
      child.kill();
      finish({ kind: "timeout", message: `No answer within ${Math.round(request.timeoutMs / 1000)} s.`, model: null, usage: null, costUsd: 0, durationMs: Date.now() - started });
    }, request.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish({ kind: "error", message: `Could not start claude: ${error.message}`, model: null, usage: null, costUsd: 0, durationMs: Date.now() - started }));
    child.on("close", () => {
      const durationMs = Date.now() - started;
      let output: PrintOutput;
      try { output = JSON.parse(stdout) as PrintOutput; }
      catch { return finish({ kind: "error", message: `Unreadable output: ${(stdout || stderr).slice(0, 300)}`, model: null, usage: null, costUsd: 0, durationMs }); }
      const models = Object.keys(output.modelUsage ?? {});
      const model = models[0] ?? null;
      const usage = output.usage ? {
        inputTokens: output.usage.input_tokens ?? 0, outputTokens: output.usage.output_tokens ?? 0,
        cacheReadTokens: output.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: output.usage.cache_creation_input_tokens ?? 0,
      } : null;
      const costUsd = output.total_cost_usd ?? 0;
      const text = output.result ?? "";
      if (output.is_error) {
        const refusal = /safeguards flagged|usage policy|aup/iu.test(text);
        return finish({ kind: refusal ? "refusal" : "error", message: text.slice(0, 400), model, usage, costUsd, durationMs });
      }
      if (models.length !== 1 || model !== request.model) {
        return finish({ kind: "error", message: `Served by ${models.join(", ") || "no model"}, not ${request.model}.`, model, usage, costUsd, durationMs });
      }
      try { finish({ kind: "ok", json: JSON.parse(text), model, usage: usage!, costUsd, durationMs }); }
      catch { finish({ kind: "error", message: `The answer was not JSON: ${text.slice(0, 300)}`, model, usage, costUsd, durationMs }); }
    });
    child.stdin.end(request.user, "utf8");
  });
}
