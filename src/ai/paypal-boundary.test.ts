/**
 * The model's side of Setti cannot move money. Money steps take a PayPal client
 * as an argument, and that client is created in one place. Code that calls the
 * model or handles what it returns must never load that place, directly or
 * through other modules, so even a fully hijacked model has no client to use.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
/** Where the PayPal SDK client is created. */
const PAYPAL_CLIENT = ["src/payments/server.ts", "src/payments/paypal-sdk.ts"];
const PAYPAL_SDK = "@paypal/paypal-server-sdk";
/** Code that calls the model or handles what it returns. */
const AI_CODE = [
  ...readdirSync(join(root, "src/ai")).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => `src/ai/${name}`),
  "src/chat/service.ts",
  "src/studio/model.ts",
];

/** Modules a file loads when it runs. `import type` and `export type` are skipped: they disappear when the code is built. */
function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) found.push(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) found.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? join(root, "src", specifier.slice(2)) : resolve(dirname(from), specifier);
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((candidate) => existsSync(candidate)) ?? null;
}

/** Everything the entry files load at run time, each with the chain of files that leads to it. */
function runtimeReach(entries: string[]) {
  const name = (file: string) => relative(root, file).replaceAll("\\", "/");
  const chains = new Map<string, string[]>();
  const packages = new Map<string, string[]>();
  const unresolved: string[] = [];
  const queue = entries.map((entry) => ({ file: join(root, entry), chain: [entry] }));
  while (queue.length) {
    const { file, chain } = queue.shift()!;
    if (chains.has(name(file))) continue;
    chains.set(name(file), chain);
    for (const specifier of runtimeSpecifiers(file)) {
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
        if (!packages.has(specifier)) packages.set(specifier, chain);
        continue;
      }
      const next = resolveLocal(file, specifier);
      if (next) queue.push({ file: next, chain: [...chain, name(next)] });
      else if (!/\.(css|json)$/.test(specifier)) unresolved.push(`${name(file)} -> ${specifier}`);
    }
  }
  return { chains, packages, unresolved };
}

describe("AI code and the PayPal client", () => {
  it("never loads the code that creates a PayPal client, so the model's side cannot move money", () => {
    const { chains, packages, unresolved } = runtimeReach(AI_CODE);
    expect(unresolved).toEqual([]);
    expect(PAYPAL_CLIENT.filter((file) => chains.has(file)).map((file) => chains.get(file)!.join(" -> "))).toEqual([]);
    expect([...packages.keys()].filter((pkg) => pkg === PAYPAL_SDK || pkg.startsWith(`${PAYPAL_SDK}/`))).toEqual([]);
  });

  it("does find the PayPal client from the payment routes, so the check above can fail", () => {
    const { chains, packages } = runtimeReach(["src/payments/http.ts"]);
    expect(PAYPAL_CLIENT.every((file) => chains.has(file))).toBe(true);
    expect(packages.has(PAYPAL_SDK)).toBe(true);
  });
});
