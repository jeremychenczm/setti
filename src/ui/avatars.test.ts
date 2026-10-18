import { describe, expect, it } from "vitest";
import { AVATARS, avatarFor } from "./avatars";

describe("avatarFor", () => {
  it("uses the avatar the person chose", () => {
    expect(avatarFor({ id: "emma", avatar: "/avatars/client.webp" })).toBe("/avatars/client.webp");
  });

  it("gives someone without an avatar the same one every time", () => {
    const picked = avatarFor({ id: "new-client" });
    expect(AVATARS).toContain(picked);
    expect(avatarFor({ id: "new-client" })).toBe(picked);
  });

  it("spreads people without avatars across the whole set", () => {
    const picked = new Set(Array.from({ length: 50 }, (_, i) => avatarFor({ id: `client-${i}` })));
    expect(picked.size).toBe(AVATARS.length);
  });
});
