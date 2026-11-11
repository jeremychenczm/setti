/**
 * Keeps the READMEs true to the code: links and anchors resolve, commands and
 * settings exist, the payment statuses match what the app shows, the documented
 * limits are the code's defaults, and every quoted button or label is in the UI.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");
const DOCS = ["README.md", "evals/README.md"];
const README = read("README.md");

function codeFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return codeFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}
/** The app's source as a reader sees it: HTML entities and curly apostrophes made plain. */
const SOURCE = codeFiles("src").map(read).join("\n")
  .replaceAll("&amp;", "&").replace(/&rsquo;|&apos;|’/g, "'");

const withoutCode = (markdown: string) => markdown.replace(/```[\s\S]*?```/g, "");
/** GitHub's heading anchors: lower case, punctuation dropped, spaces turned into hyphens. */
const anchors = (markdown: string) => new Set([...withoutCode(markdown).matchAll(/^#{1,6}\s+(.+)$/gm)]
  .map(([, heading]) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-")));
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`No "## ${heading}" section`);
  const end = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
}

describe("README links", () => {
  it.each(DOCS)("%s links only to files and headings that exist", (doc) => {
    const markdown = read(doc);
    const broken: string[] = [];
    for (const [, target] of withoutCode(markdown).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:https?:|mailto:)/.test(target)) continue;
      const [path, anchor] = target.split("#");
      const file = path ? join(dirname(doc), path) : doc;
      if (!existsSync(join(root, file))) { broken.push(target); continue; }
      if (anchor && file.endsWith(".md") && statSync(join(root, file)).isFile() && !anchors(read(file)).has(anchor)) broken.push(target);
    }
    expect(broken).toEqual([]);
  });

  it("points to the hosted demo, whose /try page exists", () => {
    expect(README).toContain("https://setti.onrender.com/try");
    expect(existsSync(join(root, "src/app/try/page.tsx"))).toBe(true);
  });
});

describe("README commands and settings", () => {
  it("names only npm scripts that package.json defines", () => {
    const scripts = Object.keys((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts);
    const named = DOCS.flatMap((doc) => [...read(doc).matchAll(/npm (?:run ([\w:-]+)|(test)\b)/g)].map(([, script, test]) => script ?? test));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((script) => !scripts.includes(script))).toEqual([]);
  });

  it("names only settings the code, .env.example or render.yaml reads", () => {
    const known = [SOURCE, read(".env.example"), read("render.yaml"), ...readdirSync(root).filter((name) => /\.config\.m?ts$/.test(name)).map(read)].join("\n");
    const named = new Set(DOCS.flatMap((doc) => [...read(doc).matchAll(/\b(?:SETTI|PAYPAL|ANTHROPIC|SANDBOX|DATABASE|TEST_DATABASE)_[A-Z_]+\b/g)].map(([name]) => name)));
    expect([...named].filter((name) => !known.includes(name))).toEqual([]);
  });

  it("states the code's default limits", () => {
    const codeDefault = (pattern: RegExp) => Number(pattern.exec(SOURCE)?.[1]);
    const readmeNumber = (pattern: RegExp) => Number(pattern.exec(README)?.[1]);
    const aiPerHour = codeDefault(/"SETTI_AI_PER_HOUR",\s*(\d+)/);
    const aiPerDay = codeDefault(/"SETTI_AI_PER_DAY",\s*(\d+)/);
    const runsPerHour = codeDefault(/SETTI_TRY_PER_HOUR[^\n]*?:\s*(\d+)/);
    expect([aiPerHour, aiPerDay, runsPerHour].every(Number.isFinite)).toBe(true);
    expect(readmeNumber(/(\d+) times an hour \(`SETTI_AI_PER_HOUR`\)/)).toBe(aiPerHour);
    expect(readmeNumber(/(\d+) times a day \(`SETTI_AI_PER_DAY`\)/)).toBe(aiPerDay);
    expect(readmeNumber(/at most (\d+) new Maple runs an hour \(`SETTI_TRY_PER_HOUR`\)/)).toBe(runsPerHour);
    expect(readmeNumber(/`SETTI_TRY_PER_HOUR` new Maple runs per hour \(default (\d+)\)/)).toBe(runsPerHour);
  });

  it("gives the Sandbox test card the code approves", () => {
    const card = /SANDBOX_TEST_CARD = \{ number: "(\d{16})"/.exec(SOURCE)?.[1];
    expect(card).toBeDefined();
    expect(README).toContain(card!.replace(/(\d{4})(?=\d)/g, "$1 "));
  });
});

describe("README payment statuses", () => {
  it("lists exactly the statuses the Payments page can show", () => {
    const progress = read("src/ui/payments/progress.ts");
    const shown = new Set<string>();
    for (const [, label] of progress.matchAll(/result\(([\s\S]*?),\s*"(?:waiting|ready|settled)"/g)) {
      for (const [, plain, template] of label.matchAll(/"([^"]+)"|`([^`]+)`/g)) shown.add(plain ?? template.replace(/\$\{[^}]+\}/g, "…"));
    }
    const documented = new Set([...section(README, "Payment statuses").matchAll(/`([^`]+)`/g)].map(([, status]) => status));
    expect(shown.size).toBeGreaterThan(10);
    expect([...documented].sort()).toEqual([...shown].sort());
  });
});

describe("README labels", () => {
  /** Buttons and labels the README quotes, with how each appears in the code. */
  const LABELS: [quoted: string, inCode: string | RegExp][] = [
    ["I'm a designer", "I'm a designer"],
    ["I'm a client", "I'm a client"],
    ["End demo & reset", "End demo & reset"],
    ["Start a separate Maple run", "Start a separate Maple run"],
    ["Previous Maple runs", "Previous Maple runs"],
    ["Browse read-only examples", "Browse read-only examples"],
    ["Pay with the test card", "Pay with the test card"],
    ["Start the live walkthrough", "Start the live walkthrough"],
    ["Sample supplier documents", "Sample supplier documents"],
    ["Prepare the revised quote", "Prepare the revised quote"],
    ["Review pricing", "Review pricing"],
    ["Save pricing review", "Save pricing review"],
    ["Send to Emma as V2", /`Send to \$\{clientFirstName\} as V\$\{nextVersion\}`/],
    ["Send to (client) as V2", /`Send to \$\{clientFirstName\} as V\$\{nextVersion\}`/],
    ["Ask about payments", "Ask about payments"],
    ["Approve ticked", "Approve ticked"],
    ["Review & sign", "Review & sign"],
    ["Check PayPal status", "Check PayPal status"],
    ["Finish charging the design services", "Finish charging the design services"],
    ["Continue on PayPal", "Continue on PayPal"],
    ["Skip ahead 3 days", "Skip ahead 3 days"],
    ["Confirmed by PayPal", "Confirmed by PayPal"],
  ];
  it.each(LABELS)("quotes %s as the app shows it", (quoted, inCode) => {
    expect(README.replace(/’/g, "'")).toContain(`**${quoted}**`);
    if (typeof inCode === "string") expect(SOURCE).toContain(inCode);
    else expect(SOURCE).toMatch(inCode);
  });
});
