import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb, testDatabaseUrl, truncate } from "@/db/testing";
import { signOpeningForTest } from "@/opening/testing";
import { completeAuthorization } from "@/payments/authorize";
import { holdApprovedItems } from "@/payments/item-holds";
import { chargeServices, startServicesCheckout } from "@/payments/services";
import { FakePayPal } from "@/payments/testing/fake-paypal";
import { links, sixChairsHeld } from "@/payments/testing/flows";
import { HOME_SCENARIO } from "@/demo/living-dining";
import { addTestProject, CHAIR, FURNITURE_CENTS, SERVICES_CENTS, TEST_KEY, testClient, testDesigner, V1_CENTS } from "@/projects/testing";
import { prepareTry, startTry, type TryDeps } from "@/try/service";
import { moneyDesk } from "./desk";
import { liveProject } from "./live";
import { deskTotals } from "./types";

const designer = testDesigner;

describe.skipIf(!testDatabaseUrl)("live projects on the money desk", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases", "try_seeds");
    session = randomUUID();
    paypal = new FakePayPal();
    await addTestProject(handle.db, session);
  });
  afterAll(() => handle?.pool.end());

  const project = () => liveProject(handle.db, session, TEST_KEY, designer);

  async function v1ServicesPaidAndItemsHeld() {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const checkout = await startServicesCheckout(handle.db, paypal, session, TEST_KEY, links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await chargeServices(handle.db, paypal, session, TEST_KEY);
    await holdApprovedItems(handle.db, paypal, session, TEST_KEY, links);
  }

  it("shows an unsent V1 with its proposed total, and nothing for a project the studio does not have", async () => {
    expect(await project()).toMatchObject({ source: "live", stage: "V1 not sent yet", agreedCents: null, proposedCents: V1_CENTS, items: [] });
    expect(await liveProject(handle.db, session, "no-such-project", designer)).toBeNull();
  });

  it("reads V1 from its item holds and design services: services charged, furniture held until the designer records the supplier", async () => {
    await v1ServicesPaidAndItemsHeld();
    const live = (await project())!;
    expect(live).toMatchObject({ source: "live", stage: "V1 approved", version: 1, agreedCents: V1_CENTS, proposedCents: null, href: "/quotes/fernhill", client: "Ava Chen" });
    expect(live.items.filter((item) => item.category === "service").every((item) => item.status === "Payment completed" && item.waitingOn === null)).toBe(true);
    const held = live.items.filter((item) => item.category === "furniture");
    expect(held).toHaveLength(4);
    expect(held.every((item) => item.status === "Awaiting supplier confirmation" && item.waitingOn === "designer" && item.heldCents === item.agreedCents)).toBe(true);
    expect(deskTotals(live)).toMatchObject({ chargedCents: SERVICES_CENTS, heldCents: FURNITURE_CENTS, notFundedCents: 0, needsYou: 4 });
  });

  it("reads a confirmed change order with the words of its payments panel", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const { v3 } = await sixChairsHeld(handle.db, paypal, session);
    const live = (await project())!;
    expect(live).toMatchObject({ stage: `V${v3.version} confirmed`, version: v3.version, href: `/quotes/${TEST_KEY}?v=${v3.version}` });
    const chairs = live.items.filter((item) => item.id.startsWith(CHAIR));
    expect(chairs.length).toBeGreaterThan(0);
    expect(chairs.some((item) => item.heldCents > 0 && item.status === "Awaiting supplier confirmation" && item.waitingOn === "designer")).toBe(true);
  });

  it("reads the prepared Maple walkthrough: services, countertop, tile, shelving and mirror charged, the pendants and stools waiting on their suppliers", async () => {
    const deps: TryDeps = { db: handle.db, paypal, links, perHour: 30, testCard: (id, options) => paypal.confirmWithTestCard(id, options) };
    const run = await startTry(deps, null, { scenario: HOME_SCENARIO });
    if (run.kind === "limited") throw new Error("Expected a scenario run");
    let ready = false;
    for (let index = 0; index < 16 && !ready; index++) {
      const step = await prepareTry(deps, run.session, run.session);
      if (step.kind === "failed" || step.kind === "not_found") throw new Error("Scenario preparation failed");
      ready = step.kind === "ready";
    }
    expect(ready).toBe(true);
    const maple = (await liveProject(handle.db, run.session, "maple", designer))!;
    expect(maple).toMatchObject({ name: "Maple Ave Café", client: "Emma Park", stage: "V1 approved", agreedCents: 1_476_000 });
    expect(deskTotals(maple)).toMatchObject({ chargedCents: 1_176_000, heldCents: 300_000, notFundedCents: 0, needsYou: 2 });
  });

  it("reads a signed V1 that is not paid yet as approved, waiting on the client", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const live = (await project())!;
    expect(live).toMatchObject({ stage: "V1 approved", version: 1, agreedCents: V1_CENTS });
    expect(live.items).toHaveLength(6);
    expect(live.items.every((item) => item.waitingOn === "client" && item.chargedCents === 0 && item.heldCents === 0)).toBe(true);
  });

  it("starting the Maple walkthrough opens a new session, so the project's money stays with the old one", async () => {
    await v1ServicesPaidAndItemsHeld();
    const deps: TryDeps = { db: handle.db, paypal, links, perHour: 30, testCard: (id, options) => paypal.confirmWithTestCard(id, options) };
    const run = await startTry(deps, session, { scenario: HOME_SCENARIO });
    if (run.kind === "limited") throw new Error("Expected a scenario run");
    expect(run.session).not.toBe(session);
    expect(await liveProject(handle.db, run.session, TEST_KEY, designer)).toBeNull();
    expect(await project()).toMatchObject({ stage: "V1 approved" });
  });

  it("is the designer's view only", async () => {
    await expect(moneyDesk(handle.db, session, testClient)).rejects.toThrow(/Only the designer/);
  });
});
