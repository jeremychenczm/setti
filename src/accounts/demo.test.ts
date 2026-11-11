import { describe, expect, it } from "vitest";
import { canOpenProject, clientOf, findAccount, type DemoAccount } from "./demo";

describe("demo accounts", () => {
  it("finds only known demo people", () => {
    expect(findAccount("sofia")?.name).toBe("Sofia Martinez");
    expect(findAccount("emma")?.role).toBe("client");
    expect(findAccount("mallory")).toBeNull();
    expect(findAccount(undefined)).toBeNull();
  });

  it("lets the designer open every project and each client only their own", () => {
    const [jordan, sofia, emma] = ["jordan", "sofia", "emma"].map((id) => findAccount(id)!);
    expect(canOpenProject(jordan, "willow") && canOpenProject(jordan, "maple")).toBe(true);
    expect([canOpenProject(sofia, "willow"), canOpenProject(sofia, "maple")]).toEqual([true, false]);
    expect([canOpenProject(emma, "willow"), canOpenProject(emma, "maple")]).toEqual([false, true]);
    expect(clientOf("willow").id).toBe("sofia");
    expect(clientOf("maple").id).toBe("emma");
  });

  it("never lets a client without a project open one", () => {
    const client: DemoAccount = { id: "a-user-id", name: "New Client", role: "client", title: "Client", projectKey: null, avatar: "/avatars/client.webp" };
    expect([canOpenProject(client, "willow"), canOpenProject(client, "maple")]).toEqual([false, false]);
  });
});
