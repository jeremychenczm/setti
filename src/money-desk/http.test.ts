import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoneyDesk } from "./types";

const mock = vi.hoisted(() => ({ moneyDesk: vi.fn() }));
vi.mock("./desk", () => ({ moneyDesk: mock.moneyDesk }));
vi.mock("@/http/demo-activity", () => ({ noteRequest: () => undefined }));
// The desk itself is mocked, so no database is opened: CI sets no DATABASE_URL for the app.
vi.mock("@/db/client", () => ({ createDb: () => ({ db: {}, pool: {} }) }));

const { getMoneyDeskResponse } = await import("./http");

const session = randomUUID();
const request = (account?: string) => new NextRequest("http://localhost:3002/api/money-desk", {
  headers: { Cookie: [`setti-demo-chat=${session}`, ...(account ? [`setti-demo-account=${account}`] : [])].join("; ") },
});
const desk: MoneyDesk = { checkedAt: "2026-11-07T12:00:00.000Z", projects: [] };

describe("the money desk endpoint", () => {
  beforeEach(() => { mock.moneyDesk.mockReset(); mock.moneyDesk.mockResolvedValue(desk); });

  it("is the designer's: a client or a visitor without an account is refused before any record is read", async () => {
    expect((await getMoneyDeskResponse(request("emma"))).status).toBe(403);
    expect((await getMoneyDeskResponse(request())).status).toBe(403);
    expect(mock.moneyDesk).not.toHaveBeenCalled();
  });

  it("gives the designer this session's desk, never cached", async () => {
    const response = await getMoneyDeskResponse(request("jordan"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(desk);
    expect(mock.moneyDesk).toHaveBeenCalledWith(expect.anything(), session, expect.objectContaining({ id: "jordan", role: "designer" }));
  });

  it("says the records could not be read rather than showing an empty desk", async () => {
    mock.moneyDesk.mockRejectedValue(new Error("connection refused"));
    const response = await getMoneyDeskResponse(request("jordan"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});
