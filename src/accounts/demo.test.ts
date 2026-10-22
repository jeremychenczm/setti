import { describe, expect, it } from "vitest";
import { accountOrDefault, canOpenProject, clientOf, findAccount } from "./demo";

describe("demo accounts", () => {
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
