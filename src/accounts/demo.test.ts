import { afterEach, describe, expect, it, vi } from "vitest";
import { accountOrDefault, canOpenProject, clientOf, findAccount, rememberAccount } from "./demo";

describe("demo accounts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["http:", "https:"])("remembers the chosen client with Lax under %s, retaining the role on PayPal GET returns", (protocol) => {
    const browser = { cookie: "" };
    vi.stubGlobal("document", browser);
    vi.stubGlobal("window", { location: { protocol } });
    rememberAccount("emma");
    expect(browser.cookie).toContain("setti-demo-account=emma;");
    expect(browser.cookie).toContain("samesite=lax");
    expect(browser.cookie).not.toContain("samesite=strict");
    expect(browser.cookie.includes("; secure")).toBe(protocol === "https:");
  });
  it("reads only known account ids and defaults to the designer", () => {
    expect(findAccount("sofia")?.name).toBe("Sofia Martinez");
    expect(findAccount("mallory")).toBeNull();
    expect(findAccount(undefined)).toBeNull();
    expect(accountOrDefault("not-an-account").id).toBe("jordan");
    expect(accountOrDefault("emma").role).toBe("client");
  });

  it("lets the designer open every project and each client only their own", () => {
    const [jordan, sofia, emma] = ["jordan", "sofia", "emma"].map((id) => accountOrDefault(id));
    expect(canOpenProject(jordan, "willow") && canOpenProject(jordan, "maple")).toBe(true);
    expect([canOpenProject(sofia, "willow"), canOpenProject(sofia, "maple")]).toEqual([true, false]);
    expect([canOpenProject(emma, "willow"), canOpenProject(emma, "maple")]).toEqual([false, true]);
    expect(clientOf("willow").id).toBe("sofia");
    expect(clientOf("maple").id).toBe("emma");
  });
});
