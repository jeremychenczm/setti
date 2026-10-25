/** Top-level GET returns from PayPal must retain the demo workspace and role.
 * Mutations independently require a strict same-origin Origin. */
export const DEMO_COOKIE_SAME_SITE = "lax" as const;
export const DEMO_SESSION_COOKIE = "setti-demo-chat";
export const DEMO_VISITOR_COOKIE = "setti-try-visitor";
export const DEMO_ACCOUNT_MAX_AGE = 60 * 60 * 24 * 365;

export function privateDemoCookieOptions(protocol: string) {
  return { httpOnly: true, sameSite: DEMO_COOKIE_SAME_SITE, path: "/", maxAge: 60 * 60 * 24 * 30, secure: protocol === "https:" } as const;
}
