import { createHash } from "node:crypto";
import type { FrozenChangeOrder } from "./types";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function changeOrderContentHash(document: Omit<FrozenChangeOrder, "contentHash">): string {
  return createHash("sha256").update(canonical(document)).digest("hex");
}

export function itemMappingKey(item: { itemId: string; name: string; vendor: string; category: string; sourceUrl: string | null; sku: string; specification: string }): string {
  const identity = { name: item.name, vendor: item.vendor, category: item.category, sourceUrl: item.sourceUrl, sku: item.sku, specification: item.specification };
  return `${item.itemId}:${createHash("sha256").update(canonical(identity)).digest("hex")}`;
}
