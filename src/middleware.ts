/**
 * Sends a signed-out visitor of a workspace page to sign in, then back. This
 * only checks that a session cookie is present; each page and API route still
 * checks the session itself on the server.
 */
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_PREFIX } from "@/auth/cookie-prefix";
import { isPublicPage } from "@/http/public-paths";

/** Better Auth's session cookie, with the `__Secure-` prefix it gets over HTTPS. */
const SESSION_COOKIES = [`${AUTH_COOKIE_PREFIX}.session_token`, `__Secure-${AUTH_COOKIE_PREFIX}.session_token`];

export function middleware(req: NextRequest) {
  if (isPublicPage(req.nextUrl.pathname) || SESSION_COOKIES.some((name) => req.cookies.get(name)?.value)) return NextResponse.next();
  const signIn = new URL("/sign-in", req.url);
  signIn.searchParams.set("next", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return NextResponse.redirect(signIn);
}

export const config = {
  // Pages only: API routes answer 401 themselves, and Next's files and public assets need no sign-in.
  matcher: ["/((?!api/|_next/|favicon\\.ico|avatars/|images/|.*\\.(?:svg|png|jpg|jpeg|webp|ico|txt|xml)$).*)"],
};
