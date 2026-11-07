import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ readVersionReceipt: vi.fn(), noteRequest: vi.fn() }));
vi.mock("./record", async (original) => ({ ...(await original<typeof import("./record")>()), readVersionReceipt: mock.readVersionReceipt }));
vi.mock("@/http/demo-activity", () => ({ noteRequest: mock.noteRequest }));
vi.mock("@/db/client", () => ({ createDb: () => ({ db: {}, pool: {} }) }));

import { getReceiptResponse } from "./http";
import { ReceiptError } from "./record";

const origin = "http://localhost:3002";
const session = "6f1c1a52-6a43-4f43-9d1e-0c5b1f0e8a11";
const get = (key: string, version: string, cookie = `setti-demo-chat=${session}`, query = "") =>
  getReceiptResponse(new NextRequest(`${origin}/api/receipts/${key}/${version}${query}`, { headers: cookie ? { Cookie: cookie } : {} }), key, version);

describe("GET /api/receipts/{project}/{version}", () => {
  beforeEach(() => {
    mock.readVersionReceipt.mockReset();
    mock.readVersionReceipt.mockResolvedValue({ receiptNo: "MAPLE-V2-E41B9A07", format: "setti-version-receipt/1" });
  });

  it("serves the session's receipt as JSON that is never cached", async () => {
    const response = await get("maple", "2");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toMatchObject({ receiptNo: "MAPLE-V2-E41B9A07" });
    expect(mock.readVersionReceipt).toHaveBeenCalledWith(expect.anything(), session, "maple", 2);
    expect(mock.noteRequest).toHaveBeenCalledWith(session);
  });

  it("sends a file named after the receipt number on download", async () => {
    const response = await get("maple", "2", `setti-demo-chat=${session}`, "?download=1");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="MAPLE-V2-E41B9A07.json"');
  });

  it("refuses an unknown project or version before reading anything", async () => {
    for (const [key, version] of [["oak", "1"], ["maple", "0"], ["maple", "x"], ["maple", "1000"]]) {
      expect((await get(key, version)).status).toBe(404);
    }
    expect(mock.readVersionReceipt).not.toHaveBeenCalled();
  });

  it("serves receipts only to the browser that owns the demo, and only to accounts in the project", async () => {
    expect((await get("maple", "2", "")).status).toBe(403);
    const other = await get("willow", "1", `setti-demo-chat=${session}; setti-demo-account=emma`);
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ error: "Emma Park is not part of this project." });
    expect((await get("maple", "2", `setti-demo-chat=${session}; setti-demo-account=emma`)).status).toBe(200);
    expect((await get("willow", "1", `setti-demo-chat=${session}; setti-demo-account=jordan`)).status).toBe(200);
  });

  it("says why there is no receipt yet", async () => {
    mock.readVersionReceipt.mockRejectedValueOnce(new ReceiptError("NOT_SIGNED", "The client has not decided on version 2 yet."));
    const unsigned = await get("maple", "2");
    expect(unsigned.status).toBe(409);
    expect(await unsigned.json()).toEqual({ code: "NOT_SIGNED", error: "The client has not decided on version 2 yet." });
    mock.readVersionReceipt.mockRejectedValueOnce(new ReceiptError("NOT_SENT", "Quote V1 has not been sent to the client yet."));
    expect((await get("willow", "1")).status).toBe(404);
    mock.readVersionReceipt.mockRejectedValueOnce(new Error("connection refused"));
    expect((await get("willow", "1")).status).toBe(503);
  });
});
