type OriginRequest = {
  headers: Pick<Headers, "get">;
  nextUrl: { protocol: string; host: string };
};

/** Next may normalize loopback URLs to localhost. The actual Host header keeps
 * the browser's authority; forwarded host/protocol headers are never trusted here. */
export function requestOrigin(req: OriginRequest): string | null {
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
