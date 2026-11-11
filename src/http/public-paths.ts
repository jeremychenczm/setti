/**
 * The pages anyone may open without signing in. Every other page needs a
 * sign-in; API routes check their own access and answer 401 themselves.
 */
const PUBLIC_PAGES = new Set(["/", "/try", "/try/cases", "/sign-in", "/sign-up", "/ai-quality"]);

export function isPublicPage(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  // A change order's link is shared with the client: anyone reads it, and only the project's people act on it.
  // An invite link is opened before its client has an account; joining still needs one.
  return PUBLIC_PAGES.has(path) || /^\/change-orders\/[^/]+$/.test(path) || /^\/invite\/[^/]+$/.test(path);
}
