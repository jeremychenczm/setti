import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredOrigin, isSameOriginRequest, requestOrigin } from "./origin";

function request(host: string | null, origin: string | null, url = "http://localhost:3002/api/try", extra: Record<string, string> = {}) {
  return new NextRequest(url, { headers: { ...(host === null ? {} : { Host: host }), ...(origin === null ? {} : { Origin: origin }), ...extra } });
}

describe("mutation request origins", () => {
  it.each(["127.0.0.1:3002", "localhost:3002", "[::1]:3002"])("uses the actual %s Host when Next's URL is normalized to localhost", (host) => {
    const req = request(host, "http://" + host);
    expect(req.nextUrl.origin).toBe("http://localhost:3002");
    expect(requestOrigin(req)).toBe("http://" + host);
    expect(isSameOriginRequest(req)).toBe(true);
  });

  it("supports HTTPS and default ports without trusting forwarded protocol", () => {
    expect(isSameOriginRequest(request("setti.example", "https://setti.example", "https://localhost/api/try"))).toBe(true);
    expect(isSameOriginRequest(request("localhost:80", "http://localhost", "http://localhost/api/try"))).toBe(true);
    expect(isSameOriginRequest(request("setti.example", "https://setti.example", "http://localhost/api/try", { "X-Forwarded-Proto": "https" }))).toBe(false);
  });

  it.each([null, "null", "", "https://attacker.example", "http://localhost:3002", "https://127.0.0.1:3002", "http://127.0.0.1:3003", "http://127.0.0.1:3002/", "http://127.0.0.1:3002@attacker.example"])("rejects missing, opaque or forged Origin %s", (origin) => {
    expect(isSameOriginRequest(request("127.0.0.1:3002", origin))).toBe(false);
  });

  it.each(["localhost:3002@attacker.example", "localhost:3002/path", "localhost:3002,attacker.example", "localhost:3002?x=1", "localhost:99999"])("rejects malformed Host %s", (host) => {
    expect(requestOrigin(request(host, "http://localhost:3002"))).toBeNull();
    expect(isSameOriginRequest(request(host, "http://localhost:3002"))).toBe(false);
  });

  it("does not accept forwarded hosts as proof of same origin", () => {
    expect(isSameOriginRequest(request("localhost:3002", "https://attacker.example", undefined, {
      "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "https", Forwarded: "host=attacker.example;proto=https",
    }))).toBe(false);
  });

  it("uses the request URL only when a synthetic request has no Host", () => {
    expect(isSameOriginRequest(request(null, "http://localhost:3002"))).toBe(true);
    expect(isSameOriginRequest(request(null, "http://127.0.0.1:3002"))).toBe(false);
    expect(isSameOriginRequest(request(null, null))).toBe(false);
  });
});

describe("a hosted server behind a proxy that ends TLS", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses its configured public origin: the app itself sees plain http", () => {
    vi.stubEnv("SETTI_PUBLIC_URL", "https://setti.onrender.com/");
    const req = request("setti.onrender.com", "https://setti.onrender.com", "http://setti.onrender.com/api/try");
    expect(requestOrigin(req)).toBe("https://setti.onrender.com");
    expect(isSameOriginRequest(req)).toBe(true);
    expect(isSameOriginRequest(request("setti.onrender.com", "https://evil.example", "http://setti.onrender.com/api/try"))).toBe(false);
    expect(isSameOriginRequest(request("setti.onrender.com", "http://setti.onrender.com", "http://setti.onrender.com/api/try"))).toBe(false);
  });

  it("ignores a configured value that is not a plain web origin", () => {
    for (const value of ["", "not a url", "ftp://setti.example", "https://user:pass@setti.example"]) expect(configuredOrigin({ SETTI_PUBLIC_URL: value })).toBeNull();
  });
});
