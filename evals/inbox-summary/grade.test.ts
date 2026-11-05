import { describe, expect, it } from "vitest";
import { stateErrors } from "./grade";
import { SCENARIOS, truthOf } from "./scenarios";

const truth = (id: string) => truthOf(SCENARIOS.find((scenario) => scenario.id === id)!.timeline());
const say = (text: string) => [{ text, factIds: ["money-now"] }];

describe("grading what a client summary says is on hold now", () => {
  it("catches the summary a client was shown on Nov 2: the charged sideboard listed as on hold", () => {
    const errors = stateErrors(say("$5,530.00 is on hold now, including $2,400.00 for the three-seat sofa, $1,400.00 for the dining table and $1,200.00 for the dining sideboard."), truth("client-held-then-charged"));
    expect(errors).toEqual([
      expect.stringMatching(/puts \$1200\.00 on hold now/),
      expect.stringMatching(/names Dining sideboard as on hold now/),
    ]);
  });

  it("accepts totals that mix charged, held and refunded amounts in one sentence", () => {
    expect(stateErrors(say("In Maple Ave, $2,200.00 has been charged in total, $5,530.00 is on hold now, and $0.00 has been refunded."), truth("client-held-then-charged"))).toEqual([]);
    expect(stateErrors(say("In Maple Ave, $6,630.00 has been charged in total, with $0.00 on hold now and $0.00 refunded."), truth("client-all-settled"))).toEqual([]);
  });

  it("accepts lists of what is held now, and past releases told as history", () => {
    expect(stateErrors(say("Holds include the three-seat sofa ($2,400.00), dining table ($1,400.00) and dining chairs ($1,080.00), among others."), truth("client-held-then-charged"))).toEqual([]);
    expect(stateErrors(say("Still on hold are the round dining table at $1,250.00 and the small round side table at $360.00."), truth("client-smaller-capture"))).toEqual([]);
    expect(stateErrors(say("Holds on the three-seat sofa ($2,400.00), coffee table ($650.00) and fixed dining table ($1,400.00) were released."), truth("client-after-v2"))).toEqual([]);
  });

  it("catches a released item or a wrong amount stated as on hold now", () => {
    expect(stateErrors(say("The three-seat sofa is still held at $2,400.00."), truth("client-after-v2"))).toEqual([
      expect.stringMatching(/puts \$2400\.00 on hold now/),
      expect.stringMatching(/names Three-seat sofa as on hold now/),
    ]);
    expect(stateErrors(say("Nothing is on hold any more."), truth("client-refund"))).toEqual([expect.stringMatching(/says nothing is on hold/)]);
  });
});
