import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { caseDocument } from "../chat/cases";
import { createChatStore } from "../chat/store";
import { items, paymentOperations, paypalAuthorizations, paypalCaptures, savedPaymentMethods, servicesHoldLines } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { completeAuthorization } from "./authorize";
import { lockOpeningVersion } from "./opening";
import { insertOperation } from "./operations";
import { chargeServices, lockPaymentBasis, startServicesCheckout } from "./services";
import { bergmund, confirmChange } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { authorizeLine, CHAIR, links } from "./testing/flows";
import { paymentsWorkspace } from "./workspace";

const SOFA = "willow-sofa", COVER = "willow-cushion-cover", DESK = "willow-desk", CONSULTATION = "willow-consultation";
const SERVICES_CENTS = 453_000;

describe.skipIf(!testDatabaseUrl)("design services: one hold, one capture per service", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
  });
  afterAll(() => handle?.pool.end());

  /** V1 signed with every line approved except the sofa (declined) and the cushion covers (undecided). */
  async function signMostOfV1() {
    const decisions = caseDocument("willow").lines.filter((line) => line.itemId !== COVER).map((line) => line.itemId === SOFA
      ? { itemId: line.itemId, decision: "declined" as const, note: "Too big for the room." }
      : { itemId: line.itemId, decision: "approved" as const });
    await signOpeningForTest(handle.db, session, "willow", decisions);
  }

  const start = () => startServicesCheckout(handle.db, paypal, session, "willow", links);
  const charge = () => chargeServices(handle.db, paypal, session, "willow");
  const basis = () => handle.db.transaction((tx) => lockPaymentBasis(tx, session, "willow"));

  async function approveServices() {
    const checkout = await start();
    paypal.approve(checkout.paypalOrderId!);
    expect((await completeAuthorization(handle.db, paypal, checkout.id)).state).toBe("authorized");
    return checkout;
  }

  async function serviceItems(): Promise<Map<string, string>> {
    return new Map((await handle.db.select({ id: items.id, name: items.name }).from(items).where(eq(items.kind, "service"))).map((row) => [row.id, row.name]));
  }

  it("holds every approved design service of V1 in one checkout that also saves PayPal", async () => {
    await signMostOfV1();
    const checkout = await start();
    expect(checkout).toMatchObject({ kind: "authorize", servicesHold: true, itemId: null, changeOrderId: null, amountCents: SERVICES_CENTS, savePaymentMethod: true });
    expect(paypal.calls[0]).toMatchObject({ amountCents: SERVICES_CENTS, referenceId: "design-services", description: "Willow Residence · Design services · V1 (Setti sandbox demo)", savePayPal: { description: expect.stringContaining("Willow Residence") } });
    const split = await handle.db.select().from(servicesHoldLines).where(eq(servicesHoldLines.operationId, checkout.id));
    expect(split).toHaveLength(6);
    expect(split.reduce((total, line) => total + line.amountCents, 0)).toBe(SERVICES_CENTS);
    expect((await start()).id).toBe(checkout.id);
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(1);
  });

  it("captures each service from the hold, records which service it paid, and closes the hold", async () => {
    await signMostOfV1();
    const checkout = await approveServices();
    const [hold] = await handle.db.select().from(paypalAuthorizations);
    expect(hold).toMatchObject({ itemId: null, amountCents: SERVICES_CENTS, operationId: checkout.id });
    expect(await handle.db.select().from(savedPaymentMethods)).toHaveLength(1);
    expect((await createChatStore(handle.db).getCase(session, "willow")).messages.at(-1)?.text)
      .toMatch(/authorization recorded for V1 · Design services: 4530\.00 USD is held .*Each design service is charged from it next\. The client saved b•••@personal\.example\.com/);

    const charged = await charge();
    expect(charged).toHaveLength(6);
    expect(charged.every((operation) => operation.status === "succeeded")).toBe(true);
    expect(charged.map((operation) => operation.finalCapture)).toEqual([false, false, false, false, false, true]);
    const captures = await handle.db.select().from(paypalCaptures);
    const services = await serviceItems();
    expect(new Set(captures.map((capture) => capture.itemId))).toEqual(new Set(services.keys()));
    expect(captures.reduce((total, capture) => total + capture.amountCents, 0)).toBe(SERVICES_CENTS);
    expect((await handle.db.select().from(paypalAuthorizations))[0].status).toBe("captured");

    const { plan } = await basis();
    expect(plan.status).not.toBe("blocked");
    expect(plan.lines.filter((line) => line.category === "service").every((line) => line.capturedCents === line.targetCents && line.heldCents === 0)).toBe(true);
    expect(plan.actions.filter((action) => action.kind === "capture")).toEqual([]);
    expect(await charge()).toEqual([]);
    await expect(start()).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("resumes a capture whose answer was lost and finishes the rest", async () => {
    await signMostOfV1();
    await approveServices();
    paypal.then("succeed", "lose-response");
    const first = await charge();
    expect(first.map((operation) => operation.status)).toEqual(["succeeded", "unknown"]);
    const rest = await charge();
    expect(rest[0]).toMatchObject({ id: first[1].id, status: "succeeded" });
    expect(rest).toHaveLength(5);
    expect(await handle.db.select().from(paypalCaptures)).toHaveLength(6);
  });

  it("refuses to take payment until the client approves a design service", async () => {
    await signOpeningForTest(handle.db, session, "willow", [{ itemId: DESK, decision: "approved" }]);
    await expect(start()).rejects.toMatchObject({ code: "NOT_AVAILABLE", message: expect.stringMatching(/Approve at least one design service/) });
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(0);
  });

  it("charges design services under the latest confirmed version once V1 was replaced", async () => {
    const v2 = await confirmChange(handle.db, session, "willow", { action: "replace", itemId: CHAIR, after: bergmund() });
    expect((await basis()).version).toBe(2);
    const checkout = await approveServices();
    expect(checkout).toMatchObject({ changeOrderId: v2.id, amountCents: SERVICES_CENTS });
    expect((await charge()).every((operation) => operation.status === "succeeded")).toBe(true);

    const workspace = (await paymentsWorkspace(handle.db, session, v2.id))!;
    const consultation = workspace.lines.find((line) => line.itemId === CONSULTATION)!;
    expect(consultation).toMatchObject({ category: "service", capturedCents: consultation.targetCents, heldCents: 0 });
    expect(consultation.captures).toHaveLength(1);
    expect(workspace.operations.find((operation) => operation.id === checkout.id)?.itemLabel).toBe("Design services");
  });

  describe("database rules", () => {
    async function openServicesHold(amountCents = SERVICES_CENTS) {
      return handle.db.transaction(async (tx) => {
        const version = await lockOpeningVersion(tx, session, "willow", null);
        return { version, operation: await insertOperation(tx, { businessKey: `test:${randomUUID()}`, projectId: version.projectId, kind: "authorize", amountCents, binding: version.bind(null), servicesHold: true }) };
      });
    }
    const itemOf = async (version: Awaited<ReturnType<typeof openServicesHold>>["version"], quoteItemId: string) => version.approved.find((entry) => entry.line.itemId === quoteItemId)!.itemId;

    it("splits a design-services hold only across approved services, within each line and the hold", async () => {
      await signMostOfV1();
      const { version, operation } = await openServicesHold(40_000);
      const split = (itemId: string, amountCents: number) => handle.db.insert(servicesHoldLines).values({ operationId: operation.id, itemId, amountCents });
      await expect(split(await itemOf(version, DESK), 10_000)).rejects.toThrow();
      await expect(split(await itemOf(version, CONSULTATION), 30_001)).rejects.toThrow();
      await split(await itemOf(version, CONSULTATION), 30_000);
      await expect(split(await itemOf(version, "willow-space-planning"), 10_001)).rejects.toThrow();
      await expect(handle.db.update(servicesHoldLines).set({ amountCents: 1 }).where(eq(servicesHoldLines.operationId, operation.id))).rejects.toThrow();
    });

    it("records the hold only when its split adds up, and allows one open design-services checkout", async () => {
      await signMostOfV1();
      const { version, operation } = await openServicesHold(40_000);
      await handle.db.insert(servicesHoldLines).values({ operationId: operation.id, itemId: await itemOf(version, CONSULTATION), amountCents: 30_000 });
      await expect(openServicesHold()).rejects.toMatchObject({ message: expect.stringMatching(/already has an open design-services checkout/) });
      await handle.db.update(paymentOperations).set({ paypalOrderId: "ORDER-1" }).where(eq(paymentOperations.id, operation.id));
      await expect(handle.db.insert(paypalAuthorizations).values({ projectId: operation.projectId, paypalOrderId: "ORDER-1", paypalAuthorizationId: "AUTH-1", amountCents: 40_000, operationId: operation.id }))
        .rejects.toThrow();
      await expect(handle.db.insert(servicesHoldLines).values({ operationId: operation.id, itemId: await itemOf(version, "willow-space-planning"), amountCents: 10_000 })).rejects.toThrow();
    });

    it("captures from the hold only a service of its split, within that service's share", async () => {
      await signMostOfV1();
      const checkout = await approveServices();
      const [hold] = await handle.db.select().from(paypalAuthorizations);
      const version = await handle.db.transaction((tx) => lockOpeningVersion(tx, session, "willow", null));
      const capture = async (quoteItemId: string, amountCents: number) => insertOperation(handle.db, {
        businessKey: `test:${randomUUID()}`, projectId: checkout.projectId, kind: "capture", authorizationId: hold.id, amountCents,
        binding: version.bind(version.approved.find((entry) => entry.line.itemId === quoteItemId)!.itemId),
      });
      await expect(capture(DESK, 10_000)).rejects.toMatchObject({ message: expect.stringMatching(/exceeds what is left of this design service's share/) });
      await expect(capture(CONSULTATION, 30_001)).rejects.toMatchObject({ message: expect.stringMatching(/exceeds what is left/) });
      const [split] = await handle.db.select().from(servicesHoldLines).limit(1);
      await expect(handle.db.insert(paypalCaptures).values({ projectId: checkout.projectId, authorizationId: hold.id, paypalCaptureId: "CAP-X", amountCents: split.amountCents }))
        .rejects.toThrow();
    });

    it("still makes a furniture capture of a confirmed version wait for the supplier", async () => {
      const v2 = await confirmChange(handle.db, session, "willow", { action: "replace", itemId: CHAIR, after: bergmund() });
      const checkout = await authorizeLine(handle.db, paypal, session, v2, "proposed");
      const [hold] = await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.operationId, checkout.id));
      await expect(insertOperation(handle.db, {
        businessKey: "test:no-supplier", projectId: checkout.projectId, kind: "capture", authorizationId: hold.id, amountCents: 10_000, finalCapture: true,
        binding: { changeOrderId: v2.id, revisionId: v2.revisionId, contentHash: v2.contentHash, revisionContentHash: v2.revisionContentHash, itemId: checkout.itemId },
      })).rejects.toMatchObject({ message: expect.stringMatching(/waits for the supplier's confirmation/) });
    });
  });
});
