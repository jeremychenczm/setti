import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "@/accounts/demo";
import { STUDIO_CASES } from "@/demo/studio-cases";
import { avatarFor, monogramFor } from "./avatars";

describe("avatars", () => {
  it("keeps each walkthrough person's own portrait, all different", () => {
    expect(avatarFor({ id: "emma", avatar: "/avatars/client.webp" })).toBe("/avatars/client.webp");
    const portraits = DEMO_ACCOUNTS.map((account) => avatarFor(account));
    expect(portraits.every(Boolean)).toBe(true);
    expect(new Set(portraits).size).toBe(DEMO_ACCOUNTS.length);
  });

  it("gives people without a portrait a monogram instead of someone else's face", () => {
    expect(avatarFor({ id: "new-client" })).toBeNull();
    expect(monogramFor({ id: "new-client", name: "Alex Rivera" })).toMatchObject({ initials: "AR" });
    expect(monogramFor({ id: "solo", name: "madonna" }).initials).toBe("MA");
    expect(monogramFor({ id: "new-client", name: "Alex Rivera" })).toEqual(monogramFor({ id: "new-client", name: "Alex Rivera" }));
  });

  it("gives every prepared project's client a different tone", () => {
    const tones = STUDIO_CASES.map((project) => monogramFor({ id: project.id, name: project.client.name }).background);
    expect(new Set(tones).size).toBe(STUDIO_CASES.length);
  });
});
