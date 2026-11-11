import { describe, expect, it } from "vitest";
import { amountErrors } from "./grade";
import { SCENARIOS, truthOf } from "./scenarios";

const truth = (id: string) => truthOf(SCENARIOS.find((scenario) => scenario.id === id)!.timeline());
const say = (text: string) => [{ text, factIds: ["money-now"] }];

describe("grading the amounts a client summary writes", () => {
  it("accepts totals that mix charged, held and refunded amounts in one sentence", () => {
    expect(amountErrors(say("In Maple Ave, $2,200.00 has been charged in total, $5,530.00 is on hold now, and $0.00 has been refunded."), truth("client-held-then-charged"))).toEqual([]);
    expect(amountErrors(say("In Maple Ave, $6,630.00 has been charged in total, with $0.00 on hold now and $0.00 refunded."), truth("client-all-settled"))).toEqual([]);
  });

  it("accepts item amounts, released holds and item-by-item sentences", () => {
    expect(amountErrors(say("Holds include the three-seat sofa ($2,400.00), dining table ($1,400.00) and dining chairs ($1,080.00), among others."), truth("client-held-then-charged"))).toEqual([]);
    expect(amountErrors(say("Holds on the three-seat sofa ($2,400.00), coffee table ($650.00) and fixed dining table ($1,400.00) were released."), truth("client-after-v2"))).toEqual([]);
    expect(amountErrors(say("2 items are charged, with nothing on hold: Design services and Dining sideboard."), truth("client-held-then-charged"))).toEqual([]);
  });

  it("catches an amount no record holds", () => {
    expect(amountErrors(say("$5,630.00 is on hold now."), truth("client-held-then-charged"))).toEqual([expect.stringMatching(/writes \$5630\.00/)]);
    expect(amountErrors(say("The round dining table is held at $1,205.00."), truth("client-smaller-capture"))).toEqual([expect.stringMatching(/writes \$1205\.00/)]);
  });
});
