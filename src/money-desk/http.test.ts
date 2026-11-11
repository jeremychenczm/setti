import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoneyDesk } from "./types";

import type { Actor } from "@/http/identity";
import { clientActor, designerActor } from "@/http/testing";

const mock = vi.hoisted(() => ({ moneyDesk: vi.fn(), requestActor: vi.fn() }));
vi.mock("./desk", () => ({ moneyDesk: mock.moneyDesk }));
vi.mock("@/http/actor", () => ({ requestActor: mock.requestActor }));
vi.mock("@/http/demo-activity", () => ({ noteRequest: () => undefined }));
// The desk itself is mocked, so no database is opened: CI sets no DATABASE_URL for the app.
vi.mock("@/db/client", () => ({ createDb: () => ({ db: {}, pool: {} }) }));

const { getMoneyDeskResponse } = await import("./http");

const studio = randomUUID();
const request = (actor: Actor | null) => {
  mock.requestActor.mockResolvedValue(actor);
  return new NextRequest("http://localhost:3002/api/money-desk");
};
const desk: MoneyDesk = { checkedAt: "2026-11-07T12:00:00.000Z", projects: [] };

describe("the money desk endpoint", () => {
  beforeEach(() => { mock.moneyDesk.mockReset(); mock.moneyDesk.mockResolvedValue(desk); });

  it("is the designer's: a client or a signed-out visitor is refused before any record is read", async () => {
    expect((await getMoneyDeskResponse(request(clientActor(studio, ["maple"])))).status).toBe(403);
    expect((await getMoneyDeskResponse(request(null))).status).toBe(401);
    expect(mock.moneyDesk).not.toHaveBeenCalled();
  });

  it("gives the designer their studio's desk, never cached", async () => {
    const response = await getMoneyDeskResponse(request(designerActor(studio, { persona: "jordan" })));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(desk);
    expect(mock.moneyDesk).toHaveBeenCalledWith(expect.anything(), studio, expect.objectContaining({ id: "jordan", role: "designer" }));
  });

  it("works for a real designer account too", async () => {
    const designer = designerActor(studio);
    await getMoneyDeskResponse(request(designer));
    expect(mock.moneyDesk).toHaveBeenCalledWith(expect.anything(), studio, expect.objectContaining({ id: designer.userId, role: "designer" }));
  });

  it("says the records could not be read rather than showing an empty desk", async () => {
    mock.moneyDesk.mockRejectedValue(new Error("connection refused"));
    const response = await getMoneyDeskResponse(request(designerActor(studio)));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});
