import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ACCOUNT_COOKIE, findAccount } from "../accounts/demo";
import { DEMO_ACCOUNT_MAX_AGE, DEMO_COOKIE_SAME_SITE, DEMO_SESSION_COOKIE, DEMO_VISITOR_COOKIE, privateDemoCookieOptions } from "../accounts/cookie-policy";

const uuid = z.uuid();

/** Upgrade existing cookies without creating an identity, selecting a role, or
 * replacing a new session explicitly set by start/resume in this response. */
export function refreshDemoCookies<T extends NextResponse>(response: T, req: NextRequest): T {
  const options = privateDemoCookieOptions(req.nextUrl.protocol);
  for (const name of [DEMO_SESSION_COOKIE, DEMO_VISITOR_COOKIE]) {
    const value = req.cookies.get(name)?.value;
    if (!response.cookies.get(name) && uuid.safeParse(value).success) response.cookies.set(name, value!, options);
  }
  const account = findAccount(req.cookies.get(ACCOUNT_COOKIE)?.value);
  if (account && !response.cookies.get(ACCOUNT_COOKIE)) response.cookies.set(ACCOUNT_COOKIE, account.id, {
    path: "/", maxAge: DEMO_ACCOUNT_MAX_AGE, sameSite: DEMO_COOKIE_SAME_SITE,
    secure: options.secure, httpOnly: false,
  });
  return response;
}
