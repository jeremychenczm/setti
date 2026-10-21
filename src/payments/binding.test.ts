import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApprovalStore, fundingIdentities } from "../approval/store";
import { createChatStore } from "../chat/store";
import { items, paymentOperations, paypalCalls, projects } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { pricingCases } from "../pricing/schema";
import { lockConfirmedVersion } from "./binding";
import { insertOperation } from "./operations";
import { bergmund, confirmChange, shown } from "./testing/cases";

const CHAIR = "willow-lisabo-dining-chair";

describe.skipIf(!testDatabaseUrl)("payment entry: confirmed version binding", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
  });
  afterAll(() => handle?.pool.end());

  const lock = (sessionId: string, orderId: string, hashes: ReturnType<typeof shown> | null, current = true) =>
    handle.db.transaction((tx) => lockConfirmedVersion(tx, sessionId, orderId, hashes, current));

  it("binds an action to the exact confirmed version, its hashes and the business item behind the line", async () => {
    const order = await confirmChange(handle.db, session, "willow", { action: "replace", itemId: CHAIR, after: bergmund() });
    const version = await lock(session, order.id, shown(order));
    const { byGroup } = fundingIdentities(version.order, version.itemMapping);
    const replacement = byGroup.get(`proposed:${CHAIR}`)!, old = byGroup.get(`baseline:${CHAIR}`)!;
    // Same quote item id, different business items: the old chair's money never counts for the new one.
    expect(replacement).toBeTruthy();
    expect(replacement).not.toBe(old);
    expect(version.bind(replacement)).toEqual({ changeOrderId: order.id, revisionId: order.revisionId, contentHash: order.contentHash, revisionContentHash: order.revisionContentHash, itemId: replacement });
  });

  it("refuses a shared read-only link, another session and changed displayed content", async () => {
    const order = await confirmChange(handle.db, session, "willow", { action: "replace", itemId: CHAIR, after: bergmund() });
    await expect(lock("", order.id, shown(order))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(lock(randomUUID(), order.id, shown(order))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(lock(session, order.id, { ...shown(order), contentHash: "0".repeat(64) })).rejects.toMatchObject({ code: "CONTENT_CHANGED" });
    await expect(lock(session, order.id, { ...shown(order), revisionContentHash: "0".repeat(64) })).rejects.toMatchObject({ code: "CONTENT_CHANGED" });
  });

  it("starts nothing from a version the client has not confirmed or that a newer confirmation replaced", async () => {
    const waiting = await confirmChange(handle.db, session, "willow", { action: "replace", itemId: CHAIR, after: bergmund() }, false);
    await expect(lock(session, waiting.id, shown(waiting))).rejects.toMatchObject({ code: "NOT_CONFIRMED" });
    await createApprovalStore(handle.db).decide(session, waiting.id, { decision: "approved", contentHash: waiting.contentHash, revisionContentHash: waiting.revisionContentHash, acknowledged: true, signature: waiting.clientName, note: "" });
    const newer = await confirmChange(handle.db, session, "willow", { action: "quantity", itemId: CHAIR, quantity: 6, after: { taxCents: 6_563 } });
    expect(newer.basedOnQuoteId).toBe(waiting.id);
    await expect(lock(session, waiting.id, shown(waiting))).rejects.toMatchObject({ code: "STALE_VERSION" });
    // An operation already started for the older version can still be reconciled against it.
    expect((await lock(session, waiting.id, shown(waiting), false)).order.id).toBe(waiting.id);
  });

  it("has the database refuse operations bound to a stale version or to another project's item", async () => {
    const first = await confirmChange(handle.db, session, "willow", { action: "replace", itemId: CHAIR, after: bergmund() });
    const version = await lock(session, first.id, shown(first));
    const chair = fundingIdentities(version.order, version.itemMapping).byGroup.get(`proposed:${CHAIR}`)!;
    const request = { businessKey: `authorize:${first.id}:${chair}:1`, projectId: version.projectId, kind: "authorize" as const, amountCents: 54_375, binding: version.bind(chair) };

    const [elsewhere] = await handle.db.insert(projects).values({ name: "Other", space: "Elsewhere", clientName: "Someone else" }).returning();
    const [foreignItem] = await handle.db.insert(items).values({ projectId: elsewhere.id, name: "Other chair", vendor: "Other" }).returning();
    await expect(insertOperation(handle.db, { ...request, businessKey: "authorize:foreign", binding: version.bind(foreignItem.id) })).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/another project/) });
    await expect(insertOperation(handle.db, { ...request, businessKey: "authorize:wrong-hash", binding: { ...version.bind(chair), contentHash: "0".repeat(64) } })).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/does not match/) });

    await confirmChange(handle.db, session, "willow", { action: "quantity", itemId: CHAIR, quantity: 6, after: { taxCents: 6_563 } });
    await expect(insertOperation(handle.db, request)).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/current client-confirmed version/) });
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(0);
  });

  it("never lets an AI draft or a client confirmation create a payment", async () => {
    await confirmChange(handle.db, session, "willow", { action: "replace", itemId: CHAIR, after: bergmund() });
    const chat = await createChatStore(handle.db).getCase(session, "willow");
    expect(chat.messages.at(-1)?.text).toContain("No payment has been executed");
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(0);
    expect(await handle.db.select().from(paypalCalls)).toHaveLength(0);
    expect(await handle.db.select().from(pricingCases)).toHaveLength(1);
  });
});
