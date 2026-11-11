/**
 * The demo's own browser cookie: the visitor id that lists the runs a browser
 * started, so one can be resumed. Who the visitor is comes from the sign-in.
 * Lax, so it survives the top-level GET back from PayPal; writes still require
 * a same-origin Origin.
 */
export const DEMO_VISITOR_COOKIE = "setti-try-visitor";
/** Cookies of the demo before it had accounts. Ending a demo clears them from older browsers. */
export const RETIRED_DEMO_COOKIES = [
  { name: "setti-demo-chat", httpOnly: true },
  { name: "setti-demo-account", httpOnly: false },
] as const;

export function privateDemoCookieOptions(protocol: string) {
  return { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30, secure: protocol === "https:" } as const;
}
