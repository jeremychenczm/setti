import { describe, expect, it } from "vitest";
import { previewTime } from "./ConversationList";

describe("chat list times", () => {
  it("shows today's messages by time and older ones by date", () => {
    const now = new Date(2026, 9, 31, 18, 0);
    expect(previewTime(new Date(2026, 9, 31, 16, 37).toISOString(), now)).toBe("4:37 PM");
    expect(previewTime(new Date(2026, 9, 30, 9, 5).toISOString(), now)).toBe("Oct 30");
    expect(previewTime("not a date", now)).toBe("");
  });
});
