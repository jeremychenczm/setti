import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductPageError, readProductPage } from "./product-page";

const url = "https://shop.example.com/products/chair";
const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
const now = () => new Date("2026-10-18T18:00:00.000Z");
function html(body: string) { return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } }); }
function fixture(product: unknown, body = "<main><h1>Fixture chair</h1><p>Two packages: frame and cover.</p></main>") {
  return `<html><head><title>Fixture chair &amp; Shop</title><script type="application/ld+json">${JSON.stringify(product)}</script></head><body>${body}</body></html>`;
}
function product(overrides: Record<string, unknown> = {}) {
  return { "@type": "Product", name: "Fixture chair, oak/gray", sku: "TEST-CHAIR-1", brand: { "@type": "Brand", name: "Fixture brand" }, description: "A chair with a removable cover.", offers: { "@type": "Offer", price: "125.00", priceCurrency: "USD", seller: { name: "Fixture merchant" }, availability: "https://schema.org/InStock" }, ...overrides };
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("readProductPage", () => {
  it("reads real response JSON-LD, preserves evidence and does not infer quantity from package count", async () => {
    const fetcher = vi.fn(async () => html(fixture(product(), "<main><h1>Fixture chair</h1><style>hidden style</style><script>untrusted script</script><p>Two packages: frame and cover.</p></main>")));
    const page = await readProductPage(url, { fetcher, resolve, now });
    expect(page.id).toBe(`page-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`);
    expect(page.fetchedAt).toBe(now().toISOString());
    expect(page.error).toBeNull();
    expect(page.title).toBe("Fixture chair & Shop");
    expect(page.products[0]).toMatchObject({ id: `${page.id}:0`, name: "Fixture chair, oak/gray", sku: "TEST-CHAIR-1", brand: "Fixture brand", seller: "Fixture merchant", unitPriceCents: 12500, currency: "USD", unitLabel: "item" });
    expect(page.products[0].priceEvidence).toContain('"price":"125.00"');
    expect(page.text).toContain("Two packages: frame and cover.");
    expect(page.text).not.toContain("untrusted script");
    expect(page.text).not.toContain("hidden style");
    expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }));
  });

  it.each([
    "http://shop.example.com/item", "https://shop.example.com:8443/item", "https://user:password@shop.example.com/item",
    "https://localhost/item", "https://metadata.internal/item", "https://foo.local/item", "https://127.0.0.1/item", "https://2130706433/item", "https://0x7f000001/item", "https://[::1]/item", "https://[::ffff:127.0.0.1]/item", "not a url",
  ])("rejects unsafe URL %s before DNS or fetch", async (unsafe) => {
    const fetcher = vi.fn(async () => html("ignored"));
    await expect(readProductPage(unsafe, { fetcher, resolve })).rejects.toMatchObject({ code: "UNSAFE_URL" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "192.0.2.1", "::1", "fe80::1", "fc00::1", "2001:db8::1", "::ffff:10.0.0.1", "2002:7f00:1::"])("rejects non-public DNS answer %s", async (address) => {
    const fetcher = vi.fn(async () => html("ignored"));
    await expect(readProductPage(url, { fetcher, resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }] })).rejects.toMatchObject({ code: "UNSAFE_DNS" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects mixed public/private DNS answers instead of choosing the public one", async () => {
    await expect(readProductPage(url, { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }], fetcher: vi.fn() })).rejects.toMatchObject({ code: "UNSAFE_DNS" });
  });

  it("validates a relative redirect again and records the final document URL", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/products/chair-final" } })).mockResolvedValueOnce(html(fixture(product())));
    const page = await readProductPage(url, { fetcher, resolve });
    expect(page.url).toBe("https://shop.example.com/products/chair-final");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(page.products[0].id).toBe(`${page.id}:0`);
  });

  it("does not follow a redirect to an IP or HTTP URL", async () => {
    for (const location of ["https://127.0.0.1/private", "http://shop.example.com/plain"]) {
      const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
      await expect(readProductPage(url, { fetcher, resolve })).rejects.toMatchObject({ code: "UNSAFE_URL" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("does not request a redirect target whose DNS resolves privately", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://other.example.com/item" } }));
    const dns = vi.fn().mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "10.0.0.2", family: 4 }]);
    await expect(readProductPage(url, { fetcher, resolve: dns })).rejects.toMatchObject({ code: "UNSAFE_DNS" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("limits redirect loops", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
    await expect(readProductPage(url, { fetcher, resolve })).rejects.toMatchObject({ code: "REDIRECT_LIMIT" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("keeps different variants and offers separate without taking the cheapest variant price", async () => {
    const data = { "@context": "https://schema.org", "@graph": [product(), product({ name: "Fixture chair, black/red", sku: "TEST-CHAIR-2", offers: { "@type": "Offer", price: "99.99", priceCurrency: "USD" } })] };
    const page = await readProductPage(url, { fetcher: async () => html(fixture(data)), resolve });
    expect(page.products.map((p) => [p.sku, p.unitPriceCents])).toEqual([["TEST-CHAIR-1", 12500], ["TEST-CHAIR-2", 9999]]);
  });

  it.each([
    [{ "@type": "Offer", price: "125", priceCurrency: "USD" }, { "@type": "Offer", price: "99", priceCurrency: "USD" }],
    [{ "@type": "Offer", price: "125", priceCurrency: "USD" }, { "@type": "Offer", price: "125", priceCurrency: "CAD" }],
    [{ "@type": "AggregateOffer", lowPrice: "99", highPrice: "125", priceCurrency: "USD" }],
    [{ "@type": "Offer", price: "125" }],
    [{ "@type": "Offer", price: "125", priceCurrency: "USD", itemOffered: { sku: "DIFFERENT-SKU" } }],
  ])("leaves conflicting or insufficient price evidence unresolved: %j", async (...offers) => {
    const page = await readProductPage(url, { fetcher: async () => html(fixture(product({ offers }))), resolve });
    expect(page.products[0].unitPriceCents).toBeNull();
    expect(page.products[0].priceEvidence).toBeTruthy();
  });

  it("does not infer seller from domain/logo and distinguishes sale units from shipping packages", async () => {
    const page = await readProductPage(url, { fetcher: async () => html(fixture({ "@graph": [{ "@type": "Organization", name: "Shop" }, product({ offers: { price: "4.99", priceCurrency: "USD" } })] })), resolve });
    expect(page.products[0].seller).toBeNull();
    expect(page.products[0].unitLabel).toBe("item");
    expect(page.products[0].priceEvidence).toContain("shipping package count is not product quantity");
  });

  it.each([
    ["Fixture light bulb 2-pack", "2-pack"],
    ["Fixture light bulb, pack of 4", "4-pack"],
    ["Fixture dining chairs, set of 2", "set of 2"],
    ["Fixture 3-piece set", "set of 3"],
    ["Fixture lamps, pair", "pair"],
    ["Fixture furniture bundle", "bundle"],
    ["Fixture dinnerware set", "set"],
  ])("preserves the offered package/set in %s", async (name, expected) => {
    const page = await readProductPage(url, { fetcher: async () => html(fixture(product({ name }))), resolve });
    expect(page.products[0].unitLabel).toBe(expected);
    expect(page.products[0].unitPriceCents).toBe(12500);
    expect(page.products[0].priceEvidence).toContain(name);
  });

  it("preserves an explicitly structured pack unit", async () => {
    const page = await readProductPage(url, { fetcher: async () => html(fixture(product({ offers: { price: "4.99", priceCurrency: "USD", priceSpecification: { referenceQuantity: { unitText: "2-pack" } } } }))), resolve });
    expect(page.products[0]).toMatchObject({ unitPriceCents: 499, unitLabel: "2-pack" });
  });

  it("does not erase title pack information when the offer says each", async () => {
    const page = await readProductPage(url, { fetcher: async () => html(fixture(product({ name: "Fixture bulbs 2-pack", offers: { price: "4.99", priceCurrency: "USD", unitText: "each" } }))), resolve });
    expect(page.products[0]).toMatchObject({ unitPriceCents: 499, unitLabel: "2-pack" });
  });

  it("leaves conflicting offer units unresolved", async () => {
    const offers = [{ price: "4.99", priceCurrency: "USD", unitText: "each" }, { price: "4.99", priceCurrency: "USD", unitText: "2-pack" }];
    const page = await readProductPage(url, { fetcher: async () => html(fixture(product({ offers }))), resolve });
    expect(page.products[0]).toMatchObject({ unitPriceCents: null, unitLabel: null });
  });

  it("does not choose between conflicting JSON-LD and meta prices", async () => {
    const body = fixture(product()).replace("</head>", '<meta property="product:price:amount" content="99.00"><meta property="product:price:currency" content="USD"></head>');
    const page = await readProductPage(url, { fetcher: async () => html(body), resolve });
    expect(page.products[0].unitPriceCents).toBeNull();
    expect(page.products[0].priceEvidence).toContain("conflictingMeta");
  });

  it("supports product meta when JSON-LD is absent, with raw field evidence", async () => {
    const body = `<html><head><meta property="og:title" content="Fixture bulb"><meta property="product:price:amount" content="4.99"><meta property="product:price:currency" content="USD"><meta property="product:retailer_item_id" content="BULB-1"></head><body>Fixture bulb</body></html>`;
    const page = await readProductPage(url, { fetcher: async () => html(body), resolve });
    expect(page.products[0]).toMatchObject({ name: "Fixture bulb", sku: "BULB-1", unitPriceCents: 499, seller: null });
    expect(page.products[0].priceEvidence).toContain('"amount":"4.99"');
  });

  it("handles malformed JSON-LD as untrusted data rather than executing it", async () => {
    const page = await readProductPage(url, { fetcher: async () => html('<title>Manual confirmation needed</title><script type="application/ld+json">{broken</script><main>Product description without verified price.</main>'), resolve });
    expect(page.products).toEqual([]);
    expect(page.text).toContain("without verified price");
  });

  it("does not fake a successful read when the merchant refuses or presents a challenge", async () => {
    await expect(readProductPage(url, { fetcher: async () => new Response("Denied", { status: 403 }), resolve })).rejects.toMatchObject({ code: "HTTP_ERROR" });
    await expect(readProductPage(url, { fetcher: async () => html("<title>Access denied</title><body>Verify you are human</body>"), resolve })).rejects.toMatchObject({ code: "BLOCKED_BY_MERCHANT" });
  });

  it("rejects non-HTML and oversized bodies, including streams without content-length", async () => {
    await expect(readProductPage(url, { fetcher: async () => new Response("%PDF", { headers: { "Content-Type": "application/pdf" } }), resolve })).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT" });
    await expect(readProductPage(url, { fetcher: async () => html("x".repeat(1_500_001)), resolve })).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(readProductPage(url, { fetcher: async () => new Response("short", { headers: { "Content-Type": "text/html", "Content-Length": "2000000" } }), resolve })).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("caps cleaned text at 20,000 characters", async () => {
    const page = await readProductPage(url, { fetcher: async () => html(fixture(product(), `<main>${"readable ".repeat(4000)}</main>`)), resolve });
    expect(page.text).toHaveLength(20_000);
  });

  it("times out stalled DNS without starting a request", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn();
    const pending = readProductPage(url, { fetcher, resolve: () => new Promise(() => undefined) });
    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("times out a stalled request after resolving public DNS", async () => {
    vi.useFakeTimers();
    const pending = readProductPage(url, { fetcher: () => new Promise(() => undefined), resolve });
    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
  });

  it("wraps network errors in a readable error and never substitutes a product", async () => {
    await expect(readProductPage(url, { fetcher: async () => { throw new Error("network"); }, resolve })).rejects.toBeInstanceOf(ProductPageError);
  });
});
