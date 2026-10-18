import { createInterface } from "node:readline/promises";

/** Reads `--name value` style arguments. */
export function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument --${name}`);
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Pauses until the person running the probe confirms a manual step (buyer approval). */
export async function waitForEnter(message: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`\n${message}\nPress Enter when done... `);
  rl.close();
}

/**
 * Waits for a buyer approval step. In an interactive terminal it waits for Enter;
 * otherwise (for example when the probe runs in the background) it polls
 * `isApproved` until PayPal reports the approval or the timeout passes.
 */
export async function waitForApproval(
  message: string,
  isApproved: () => Promise<boolean>,
  { intervalMs = 5_000, timeoutMs = 30 * 60_000 } = {},
): Promise<void> {
  if (process.stdin.isTTY) return waitForEnter(message);
  console.log(`\n${message}\nWaiting for approval (checking every ${intervalMs / 1000}s)...`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await isApproved()) {
        console.log("Approved.");
        return;
      }
    } catch {
      // A failed status read is not fatal; try again on the next tick.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`No buyer approval within ${timeoutMs / 60_000} minutes`);
}

export function run(main: () => Promise<void>): void {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
