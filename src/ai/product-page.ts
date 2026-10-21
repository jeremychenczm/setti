import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import type { ProductOption, ProductPage } from "@/chat/types";

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20_000;
type Address = { address: string; family: number };
type JsonObject = Record<string, unknown>;

export class ProductPageError extends Error {
  constructor(message: string, public readonly code = "PRODUCT_PAGE_UNAVAILABLE") {
    super(message);
    this.name = "ProductPageError";
  }
}

export interface ProductPageOptions {
  /** Trusted test seam only. Production uses a DNS-pinned HTTPS connection. */
  fetcher?: typeof fetch;
  now?: () => Date;
  resolve?: (hostname: string) => Promise<Address[]>;
}

function safeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProductPageError("商品链接不是有效的网址。", "UNSAFE_URL"); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (value.length > 4096 || url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || /(^|\.)(localhost|local|internal|lan|home|test|invalid|onion)$/.test(host)) {
    throw new ProductPageError("仅支持公共 HTTPS 商品链接；不允许本地地址、IP 地址、登录凭据或非标准端口。", "UNSAFE_URL");
  }
  url.hash = "";
  return url;
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    // Only global unicast; exclude documentation and transition/special ranges.
    const parts = address.toLowerCase().split(":");
    const first = parseInt(parts[0], 16);
    const second = parseInt(parts[1] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) && !address.includes(".");
  }
  return false;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new ProductPageError("读取商品页超时，请稍后重试。", "TIMEOUT"));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Resolve once, then pin this exact public address while preserving TLS SNI. */
async function pinnedFetch(url: URL, address: Address, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const pinnedLookup: LookupFunction = (_host, options, callback) => {
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
    const req = httpsRequest(url, {
      method: "GET", signal, lookup: pinnedLookup, agent: false,
      headers: { Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "identity", "User-Agent": "Setti-ProductReader/1.0" },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { res.destroy(new ProductPageError("商品页过大，未读取。", "TOO_LARGE")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        const status = res.statusCode ?? 502;
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks).toString("utf8"), { status, headers }));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function boundedHtml(response: Response, signal: AbortSignal): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_BYTES) throw new ProductPageError("商品页过大，未读取。", "TOO_LARGE");
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^(text\/html|application\/xhtml\+xml)(;|$)/.test(type)) throw new ProductPageError("链接没有返回 HTML 商品页。", "UNSUPPORTED_CONTENT");
  if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") throw new ProductPageError("商品页返回了不支持的压缩格式，资料仍待确认。", "UNSUPPORTED_CONTENT");
  if (!response.body) throw new ProductPageError("商品页内容为空。", "EMPTY_PAGE");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = "";
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw new ProductPageError("商品页过大，未读取。", "TOO_LARGE");
      html += decoder.decode(part.value, { stream: true });
    }
    return html + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); }
}

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity: string) => {
    const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? match;
    const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

function plain(text: string): string {
  return decode(text.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4]);
  return result;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? plain(value).slice(0, 2000) : null; }
function label(value: unknown): string | null { return string(value) ?? string(object(value)?.name); }
function money(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** One Offer price buys one offered Product, which may itself be a pack/set. */
function salesUnit(name: string): string {
  const pack = name.match(/\b(\d+)\s*[- ]?\s*pack\b|\bpack\s+of\s+(\d+)\b/i);
  if (pack) return `${pack[1] ?? pack[2]}-pack`;
  const set = name.match(/\bset\s+of\s+(\d+)\b|\b(\d+)\s*[- ]?piece\s+set\b/i);
  if (set) return `set of ${set[1] ?? set[2]}`;
  if (/\bpair\b/i.test(name)) return "pair";
  if (/\bbundle\b/i.test(name)) return "bundle";
  if (/\bset\b/i.test(name)) return "set";
  if (/\bpack\b/i.test(name)) return "pack";
  // This means a sale unit, not a physical component or shipping package.
  return "item";
}

function extract(html: string, pageId: string): { title: string; text: string; products: ProductOption[] } {
  const meta: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if (attrs.content) meta[(attrs.property ?? attrs.name ?? "").toLowerCase()] = attrs.content;
  }
  const title = plain(meta["og:title"] ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "商品页");
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1] ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? html;
  const text = plain(main).slice(0, 20_000);
  const nodes: JsonObject[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 25 || nodes.length > 2000) return;
    if (Array.isArray(value)) { value.forEach((entry) => visit(entry, depth + 1)); return; }
    const entry = object(value);
    if (entry) { nodes.push(entry); Object.values(entry).forEach((child) => visit(child, depth + 1)); }
  };
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attributes(script[1]).type?.toLowerCase().split(";")[0] !== "application/ld+json") continue;
    try { visit(JSON.parse(script[2].trim())); } catch { /* Malformed external data is not executable. */ }
  }
  const byId = new Map(nodes.filter((n) => typeof n["@id"] === "string").map((n) => [n["@id"], n]));
  const dereference = (value: unknown) => { const n = object(value); return n && typeof n["@id"] === "string" ? { ...byId.get(n["@id"]), ...n } : n; };
  const products: ProductOption[] = [];
  const seen = new Set<string>();
  for (const product of nodes) {
    const types = Array.isArray(product["@type"]) ? product["@type"] : [product["@type"]];
    if (!types.some((type) => type === "Product" || type === "ProductModel")) continue;
    const name = string(product.name);
    if (!name) continue;
    const sku = string(product.sku) ?? string(product.productID);
    const key = JSON.stringify([name, sku, product.offers]);
    if (seen.has(key)) continue;
    seen.add(key);
    const offerValues = Array.isArray(product.offers) ? product.offers : [product.offers];
    const offers = offerValues.map(dereference).filter((offer): offer is JsonObject => offer !== null);
    // AggregateOffer.lowPrice is not a price for this exact SKU/variant.
    const amounts = offers.map((offer) => money(offer.price));
    const currencies = offers.map((offer) => string(offer.priceCurrency)?.toUpperCase() ?? null);
    const mismatchedSku = offers.some((offer) => {
      const offeredSku = string(offer.sku) ?? string(object(offer.itemOffered)?.sku);
      return sku && offeredSku && sku !== offeredSku;
    });
    const aggregate = offers.some((offer) => [offer["@type"]].flat().includes("AggregateOffer"));
    const consistent = !mismatchedSku && !aggregate && offers.length > 0 && amounts.every((p) => p !== null && p === amounts[0]) && currencies.every((c) => c !== null && /^[A-Z]{3}$/.test(c) && c === currencies[0]);
    const unitValues = offers.map((offer) => {
      const spec = object(offer.priceSpecification);
      const reference = object(spec?.referenceQuantity);
      const referenceUnit = string(reference?.unitText);
      const referenceValue = reference?.value;
      return string(spec?.unitText) ?? (referenceUnit && typeof referenceValue === "number" && referenceValue !== 1 ? `${referenceValue} ${referenceUnit}` : referenceUnit) ?? string(offer.unitText);
    });
    const sellerValues = offers.map((offer) => label(offer.seller));
    const ambiguousUnits = unitValues.length > 1 && unitValues.some((unit) => unit !== unitValues[0]);
    const usableOffer = consistent && !ambiguousUnits;
    const explicitUnit = unitValues.length && unitValues.every((v) => v !== null && v === unitValues[0]) ? unitValues[0] : null;
    const namedUnit = salesUnit(name);
    const unitLabel = ambiguousUnits ? null : explicitUnit && !(namedUnit !== "item" && /^(each|item|piece|unit)$/i.test(explicitUnit)) ? explicitUnit : usableOffer ? namedUnit : null;
    const specification = [string(product.description), string(product.color), string(product.size), string(product.material)].filter(Boolean).join(" · ").slice(0, 3000);
    products.push({
      id: `${pageId}:${products.length}`, name, sku, brand: label(product.brand),
      seller: sellerValues.length && sellerValues.every((v) => v === sellerValues[0]) ? sellerValues[0] : null,
      specification, currency: usableOffer ? currencies[0] : null, unitPriceCents: usableOffer ? amounts[0] : null,
      unitLabel,
      priceEvidence: offers.length ? JSON.stringify({ product: { name, sku }, offers, salesUnit: unitLabel, unitBasis: explicitUnit && unitLabel === explicitUnit ? "Explicit structured offer unit" : usableOffer ? "Offer.price for one offered Product sales unit; title pack/set retained; shipping package count is not product quantity" : "Unknown or conflicting offer" }).slice(0, 8000) : null,
      availability: offers.length === 1 ? string(offers[0].availability) : null,
    });
    if (products.length >= 20) break;
  }
  if (!products.length && (meta["product:price:amount"] || meta["og:price:amount"])) {
    const amount = meta["product:price:amount"] ?? meta["og:price:amount"];
    const currency = meta["product:price:currency"] ?? meta["og:price:currency"] ?? null;
    const validCurrency = currency && /^[A-Z]{3}$/.test(currency) ? currency : null;
    products.push({ id: `${pageId}:0`, name: title, sku: meta["product:retailer_item_id"] ?? null, brand: meta["product:brand"] ?? null, seller: null, specification: plain(meta["og:description"] ?? ""), currency: validCurrency, unitPriceCents: validCurrency ? money(amount) : null, unitLabel: null, priceEvidence: JSON.stringify({ source: "HTML meta", amount, currency }), availability: null });
  }
  const metaAmount = meta["product:price:amount"] ?? meta["og:price:amount"];
  const metaCurrency = meta["product:price:currency"] ?? meta["og:price:currency"];
  for (const product of products) {
    const belongsToProduct = products.length === 1 || (meta["product:retailer_item_id"] && meta["product:retailer_item_id"] === product.sku);
    if (belongsToProduct && product.unitPriceCents !== null && ((metaAmount !== undefined && money(metaAmount) !== product.unitPriceCents) || (metaCurrency !== undefined && metaCurrency !== product.currency))) {
      product.priceEvidence = JSON.stringify({ jsonLdEvidence: product.priceEvidence, conflictingMeta: { amount: metaAmount, currency: metaCurrency } }).slice(0, 8000);
      product.unitPriceCents = null;
      product.currency = null;
    }
  }
  if (!text && !products.length) throw new ProductPageError("商品页没有可读内容。", "EMPTY_PAGE");
  if (!products.length && /access denied|request blocked|verify you are human|captcha|robot check/i.test(`${title} ${text.slice(0, 2000)}`)) throw new ProductPageError("商家阻止了自动读取，商品资料仍待确认。", "BLOCKED_BY_MERCHANT");
  return { title, text, products };
}

export async function readProductPage(value: string, options: ProductPageOptions = {}): Promise<ProductPage> {
  let current = safeUrl(value);
  const id = `page-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const resolve = options.resolve ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const addresses = await abortable(resolve(current.hostname), controller.signal);
      if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new ProductPageError("商品链接解析到了非公共网络地址，已拒绝读取。", "UNSAFE_DNS");
      const response = await abortable(options.fetcher ? options.fetcher(current.toString(), { method: "GET", redirect: "manual", signal: controller.signal, headers: { Accept: "text/html,application/xhtml+xml" } }) : pinnedFetch(current, addresses[0], controller.signal), controller.signal);
      if (response.redirected) throw new ProductPageError("读取器不允许未检查的自动跳转。", "UNSAFE_REDIRECT");
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || hop === MAX_REDIRECTS) throw new ProductPageError("商品链接跳转过多或跳转地址缺失。", "REDIRECT_LIMIT");
        current = safeUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new ProductPageError(`商家商品页返回 HTTP ${response.status}，资料仍待确认。`, "HTTP_ERROR"); }
      const html = await boundedHtml(response, controller.signal);
      const result = extract(html, id);
      return { id, url: current.toString(), fetchedAt: (options.now?.() ?? new Date()).toISOString(), ...result, error: null };
    }
    throw new ProductPageError("商品链接跳转过多。", "REDIRECT_LIMIT");
  } catch (error) {
    if (error instanceof ProductPageError) throw error;
    if (controller.signal.aborted) throw new ProductPageError("读取商品页超时，请稍后重试。", "TIMEOUT");
    throw new ProductPageError("无法读取商家商品页；请稍后重试或由设计师确认商品资料。", "FETCH_FAILED");
  } finally { clearTimeout(timer); }
}
