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

export function run(main: () => Promise<void>): void {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
