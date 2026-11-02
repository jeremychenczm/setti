type OriginRequest = {
  headers: Pick<Headers, "get">;
  nextUrl: { protocol: string; host: string };
};

/**
 * The public origin configured for a hosted server (SETTI_PUBLIC_URL). Behind a
 * proxy that ends TLS, the app itself sees plain http, so the configured value is
 * the only trustworthy answer; it is set by the operator, never by a request.
 */
export function configuredOrigin(env: Partial<Record<string, string>> = process.env): string | null {
  const raw = env.SETTI_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

/** Next may normalize loopback URLs to localhost. The actual Host header keeps
 * the browser's authority; forwarded host/protocol headers are never trusted here.
 * A hosted server answers with its configured public origin instead. */
export function requestOrigin(req: OriginRequest): string | null {
  const configured = configuredOrigin();
  if (configured) return configured;
  const protocol = req.nextUrl.protocol;
  if (protocol !== "http:" && protocol !== "https:") return null;
  // A synthetic NextRequest may omit Host; real HTTP requests supply it.
  const host = req.headers.get("host") ?? req.nextUrl.host;
  if (!host || /[\s,/@\\?#]/.test(host)) return null;
  try {
    const parsed = new URL(protocol + "//" + host);
    return parsed.hostname && !parsed.username && !parsed.password && parsed.pathname === "/" ? parsed.origin : null;
  } catch { return null; }
}

/** Mutation requests require the browser's serialized Origin, including protocol
 * and non-default port. Missing/null origins and loopback aliases do not match. */
export function isSameOriginRequest(req: OriginRequest): boolean {
  const origin = req.headers.get("origin");
  return !!origin && origin !== "null" && origin === requestOrigin(req);
}
