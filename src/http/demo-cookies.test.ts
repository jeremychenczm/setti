import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { privateDemoCookieOptions } from "../accounts/cookie-policy";
import { refreshDemoCookies } from "./demo-cookies";

describe("demo cookie policy across PayPal's top-level GET return", () => {
  const session = randomUUID(), visitor = randomUUID();
  const request = (cookie?: string, protocol = "http") => new NextRequest(protocol + "://localhost/api/try", { headers: cookie ? { Cookie: cookie } : {} });

  it("upgrades the existing workspace, visitor and selected role without changing their values", () => {
    const response = refreshDemoCookies(NextResponse.json({}), request("setti-demo-chat=" + session + "; setti-try-visitor=" + visitor + "; setti-demo-account=emma"));
    expect(response.cookies.get("setti-demo-chat")).toMatchObject({ value: session, sameSite: "lax", httpOnly: true, path: "/" });
    expect(response.cookies.get("setti-try-visitor")).toMatchObject({ value: visitor, sameSite: "lax", httpOnly: true, path: "/" });
    expect(response.cookies.get("setti-demo-account")).toMatchObject({ value: "emma", sameSite: "lax", httpOnly: false, path: "/" });
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");
  });

  it("keeps private cookies HttpOnly and enables Secure under HTTPS", () => {
    const response = refreshDemoCookies(NextResponse.json({}), request("setti-demo-chat=" + session + "; setti-demo-account=sofia", "https"));
    expect(response.cookies.get("setti-demo-chat")).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax" });
    expect(response.cookies.get("setti-demo-account")).toMatchObject({ value: "sofia", secure: true, httpOnly: false });
  });

  it("never mints a workspace or chooses a default role from missing or malformed cookies", () => {
    for (const cookie of [undefined, "setti-demo-chat=not-a-uuid; setti-try-visitor=wrong; setti-demo-account=unknown"]) {
      const response = refreshDemoCookies(NextResponse.json({}), request(cookie));
      expect(response.cookies.getAll()).toEqual([]);
    }
    const callback = new NextRequest("http://localhost/api/payments/paypal/return?token=ORDER-EMMA&account=emma");
    expect(refreshDemoCookies(NextResponse.json({}), callback).cookies.getAll()).toEqual([]);
  });

  it("does not overwrite a new run explicitly selected by start or resume", () => {
    const next = randomUUID(), response = NextResponse.json({});
    response.cookies.set("setti-demo-chat", next, privateDemoCookieOptions("http:"));
    refreshDemoCookies(response, request("setti-demo-chat=" + session + "; setti-try-visitor=" + visitor + "; setti-demo-account=emma"));
    expect(response.cookies.get("setti-demo-chat")?.value).toBe(next);
    expect(response.cookies.get("setti-try-visitor")?.value).toBe(visitor);
    expect(response.cookies.get("setti-demo-account")?.value).toBe("emma");
  });
});
