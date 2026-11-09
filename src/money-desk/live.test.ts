import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "@/accounts/demo";
import { caseDocument } from "@/chat/cases";
import { createChatStore } from "@/chat/store";
import { openTestDb, testDatabaseUrl, truncate } from "@/db/testing";
import { signOpeningForTest } from "@/opening/testing";
import { completeAuthorization } from "@/payments/authorize";
import { holdApprovedItems } from "@/payments/item-holds";
import { chargeServices, startServicesCheckout } from "@/payments/services";
import { FakePayPal } from "@/payments/testing/fake-paypal";
import { links, sixChairsHeld } from "@/payments/testing/flows";
import { HOME_SCENARIO } from "@/demo/living-dining";
import { prepareTry, startTry, type TryDeps } from "@/try/service";
import { moneyDesk } from "./desk";
import { liveProject } from "./live";
import { deskTotals } from "./types";

const [designer, client] = DEMO_ACCOUNTS;
const WILLOW = caseDocument("willow");
const lineTotal = (line: (typeof WILLOW.lines)[number]) => line.quantity * line.unitPriceCents + line.taxCents + line.freightCents;

describe.skipIf(!testDatabaseUrl)("live projects on the money desk", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases", "try_seeds");
    session = randomUUID();
    paypal = new FakePayPal();
  });
  afterAll(() => handle?.pool.end());

  const willow = () => liveProject(handle.db, session, "willow", designer);

  async function v1ServicesPaidAndItemsHeld() {
    await signOpeningForTest(handle.db, session, "willow");
    const checkout = await startServicesCheckout(handle.db, paypal, session, "willow", links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await chargeServices(handle.db, paypal, session, "willow");
    await holdApprovedItems(handle.db, paypal, session, "willow", links);
  }

  it("leaves out a project this session never opened", async () => {
    expect(await willow()).toBeNull();
    expect((await moneyDesk(handle.db, session, designer)).projects.every((project) => project.source === "example")).toBe(true);
  });

  it("reads V1 from its item holds and design services: services charged, furniture held until the designer records the supplier", async () => {
    await v1ServicesPaidAndItemsHeld();
    const project = (await willow())!;
    const services = WILLOW.lines.filter((line) => line.category === "service"), furniture = WILLOW.lines.filter((line) => line.category === "furniture");
    expect(project).toMatchObject({ source: "live", stage: "V1 approved", version: 1, proposedCents: null, href: "/quotes/willow", client: "Sofia Martinez" });
    expect(project.agreedCents).toBe(WILLOW.lines.reduce((total, line) => total + lineTotal(line), 0));
    expect(project.items.filter((item) => item.category === "service").every((item) => item.status === "Payment completed" && item.waitingOn === null)).toBe(true);
    const held = project.items.filter((item) => item.category === "furniture");
    expect(held).toHaveLength(furniture.length);
    expect(held.every((item) => item.status === "Awaiting supplier confirmation" && item.waitingOn === "designer" && item.heldCents === item.agreedCents)).toBe(true);
    expect(deskTotals(project)).toMatchObject({
      chargedCents: services.reduce((total, line) => total + lineTotal(line), 0),
      heldCents: furniture.reduce((total, line) => total + lineTotal(line), 0),
      notFundedCents: 0, needsYou: furniture.length,
    });
  });

  it("reads a confirmed change order with the words of its payments panel", async () => {
    await signOpeningForTest(handle.db, session, "willow");
    const { v3 } = await sixChairsHeld(handle.db, paypal, session);
    const project = (await willow())!;
    expect(project).toMatchObject({ stage: `V${v3.version} confirmed`, version: v3.version, href: `/change-orders/${v3.id}` });
    const chairs = project.items.filter((item) => item.id.startsWith("willow-dining-chair"));
    expect(chairs.length).toBeGreaterThan(0);
    expect(chairs.some((item) => item.heldCents > 0 && item.status === "Awaiting supplier confirmation" && item.waitingOn === "designer")).toBe(true);
  });

  it("reads the prepared Maple walkthrough: design fee and sideboard charged, four pieces waiting on their suppliers", async () => {
    const deps: TryDeps = { db: handle.db, paypal, links, perHour: 30, testCard: (id, options) => paypal.confirmWithTestCard(id, options) };
    const run = await startTry(deps, null, { scenario: HOME_SCENARIO });
    if (run.kind === "limited") throw new Error("Expected a scenario run");
    let ready = false;
    for (let index = 0; index < 12 && !ready; index++) {
      const step = await prepareTry(deps, run.session, run.session);
      if (step.kind === "failed" || step.kind === "not_found") throw new Error("Scenario preparation failed");
      ready = step.kind === "ready";
    }
    expect(ready).toBe(true);
    const project = (await liveProject(handle.db, run.session, "maple", designer))!;
    expect(project).toMatchObject({ name: "Maple Ave", client: "Emma Park", stage: "V1 approved", agreedCents: 773_000 });
    expect(deskTotals(project)).toMatchObject({ chargedCents: 220_000, heldCents: 553_000, notFundedCents: 0, needsYou: 4 });
  });

  it("reads a signed V1 that is not paid yet as approved, waiting on the client", async () => {
    await signOpeningForTest(handle.db, session, "willow");
    const project = (await willow())!;
    expect(project).toMatchObject({ stage: "V1 approved", version: 1 });
    expect(project.items.length).toBe(WILLOW.lines.length);
    expect(project.items.every((item) => item.waitingOn === "client" && item.chargedCents === 0 && item.heldCents === 0)).toBe(true);
  });

  it("starting the Maple walkthrough opens a new session, so Willow's money stays with the old one", async () => {
    await v1ServicesPaidAndItemsHeld();
    const deps: TryDeps = { db: handle.db, paypal, links, perHour: 30, testCard: (id, options) => paypal.confirmWithTestCard(id, options) };
    const run = await startTry(deps, session, { scenario: HOME_SCENARIO });
    if (run.kind === "limited") throw new Error("Expected a scenario run");
    expect(run.session).not.toBe(session);
    await createChatStore(handle.db).getCase(run.session, "willow");
    expect(await liveProject(handle.db, run.session, "willow", designer)).toMatchObject({ stage: "V1 not sent yet", items: [] });
    expect(await willow()).toMatchObject({ stage: "V1 approved" });
  });

  it("is the designer's view only", async () => {
    await expect(moneyDesk(handle.db, session, client)).rejects.toThrow(/Only the designer/);
  });
});
