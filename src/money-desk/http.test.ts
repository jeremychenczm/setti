import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { testDatabaseUrl } from "@/db/testing";
import { getMoneyDeskResponse } from "./http";
import type { MoneyDesk } from "./types";

const request = (account?: string) => new NextRequest("http://localhost:3002/api/money-desk", {
  headers: { Cookie: [`setti-demo-chat=${randomUUID()}`, ...(account ? [`setti-demo-account=${account}`] : [])].join("; ") },
});

describe.skipIf(!testDatabaseUrl)("the money desk endpoint", () => {
  it("is the designer's: a client or a visitor without an account is refused", async () => {
    expect((await getMoneyDeskResponse(request("emma"))).status).toBe(403);
    expect((await getMoneyDeskResponse(request())).status).toBe(403);
  });

  it("gives the designer the prepared examples even before any live project exists", async () => {
    const response = await getMoneyDeskResponse(request("jordan"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const desk = await response.json() as MoneyDesk;
    expect(desk.projects.length).toBeGreaterThan(0);
    expect(desk.projects.every((project) => project.source === "example")).toBe(true);
  });
});
