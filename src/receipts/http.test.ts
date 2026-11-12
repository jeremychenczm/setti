import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Actor } from "@/http/identity";
import { clientActor, designerActor } from "@/http/testing";

const mock = vi.hoisted(() => ({ readVersionReceipt: vi.fn(), noteRequest: vi.fn(), requestActor: vi.fn() }));
vi.mock("./record", async (original) => ({ ...(await original<typeof import("./record")>()), readVersionReceipt: mock.readVersionReceipt }));
vi.mock("@/http/demo-activity", () => ({ noteRequest: mock.noteRequest }));
vi.mock("@/http/actor", () => ({ requestActor: mock.requestActor }));
vi.mock("@/db/client", () => ({ createDb: () => ({ db: {}, pool: {} }) }));

import { getReceiptResponse } from "./http";
import { ReceiptError } from "./record";

const origin = "http://localhost:3002";
const studio = "6f1c1a52-6a43-4f43-9d1e-0c5b1f0e8a11";
const designer = designerActor(studio);
const get = (key: string, version: string, actor: Actor | null = designer, query = "") => {
  mock.requestActor.mockResolvedValue(actor);
  return getReceiptResponse(new NextRequest(`${origin}/api/receipts/${key}/${version}${query}`), key, version);
};

describe("GET /api/receipts/{project}/{version}", () => {
  beforeEach(() => {
    mock.readVersionReceipt.mockReset();
    mock.readVersionReceipt.mockResolvedValue({ receiptNo: "MAPLE-V2-E41B9A07", format: "setti-version-receipt/1" });
  });

  it("serves the studio's receipt as JSON that is never cached", async () => {
    const response = await get("maple", "2");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toMatchObject({ receiptNo: "MAPLE-V2-E41B9A07" });
    expect(mock.readVersionReceipt).toHaveBeenCalledWith(expect.anything(), studio, "maple", 2);
    expect(mock.noteRequest).toHaveBeenCalledWith(studio);
  });

  it("sends a file named after the receipt number on download", async () => {
    const response = await get("maple", "2", designer, "?download=1");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="MAPLE-V2-E41B9A07.json"');
  });

  it("refuses an unknown project or version before reading anything", async () => {
    for (const [key, version] of [["Oak", "1"], ["maple", "0"], ["maple", "x"], ["maple", "1000"]]) {
      expect((await get(key, version)).status).toBe(404);
    }
    expect(mock.readVersionReceipt).not.toHaveBeenCalled();
  });

  it("serves receipts only to a signed-in studio member or the project's client", async () => {
    const signedOut = await get("maple", "2", null);
    expect(signedOut.status).toBe(401);
    expect(await signedOut.json()).toMatchObject({ code: "SIGN_IN_REQUIRED" });
    const emma = clientActor(studio, ["maple"]);
    const other = await get("fernhill", "1", emma);
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(mock.readVersionReceipt).not.toHaveBeenCalled();
    expect((await get("maple", "2", emma)).status).toBe(200);
    expect(mock.readVersionReceipt).toHaveBeenLastCalledWith(expect.anything(), studio, "maple", 2);
    expect((await get("fernhill", "1", designer)).status).toBe(200);
  });

  it("reads a client's receipt from the studio that owns the project", async () => {
    const elsewhere = "0b7d2c1e-8f3a-4c5d-9e6f-1a2b3c4d5e6f";
    await get("maple", "2", clientActor(elsewhere, ["maple"]));
    expect(mock.readVersionReceipt).toHaveBeenCalledWith(expect.anything(), elsewhere, "maple", 2);
  });

  it("says why there is no receipt yet", async () => {
    mock.readVersionReceipt.mockRejectedValueOnce(new ReceiptError("NOT_SENT", "Quote V1 has not been sent to the client yet."));
    const unsent = await get("fernhill", "1");
    expect(unsent.status).toBe(404);
    expect(await unsent.json()).toEqual({ code: "NOT_SENT", error: "Quote V1 has not been sent to the client yet." });
    mock.readVersionReceipt.mockRejectedValueOnce(new Error("connection refused"));
    expect((await get("fernhill", "1")).status).toBe(503);
  });
});
