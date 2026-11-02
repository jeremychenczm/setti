/**
 * How many model calls this server makes for visitors: at most SETTI_AI_PER_HOUR
 * per demo session (default 40) and SETTI_AI_PER_DAY in all (default 500). The
 * count lives in this process, which a single hosted instance keeps; a restart
 * starts it again. A refusal says when to retry; the message itself is saved.
 */
const HOUR_MS = 60 * 60 * 1000;
const sessions = new Map<string, number[]>();
let day = "";
let today = 0;

function limit(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Takes one model call from the budget, or says why not. */
export function takeAiBudget(sessionId: string | null, now = Date.now()): string | null {
  const date = new Date(now).toISOString().slice(0, 10);
  if (date !== day) { day = date; today = 0; }
  if (today >= limit("SETTI_AI_PER_DAY", 500)) return "Setti has used today's AI budget for this demo server. Your message is saved; try again tomorrow.";
  const key = sessionId ?? "anonymous";
  const recent = (sessions.get(key) ?? []).filter((at) => now - at < HOUR_MS);
  if (recent.length >= limit("SETTI_AI_PER_HOUR", 40)) return "This demo has asked the AI many times this hour. Your message is saved; try again in a little while.";
  recent.push(now);
  sessions.set(key, recent);
  today += 1;
  return null;
}

/** For tests: forget every count. */
export function resetAiBudget(): void { sessions.clear(); day = ""; today = 0; }
