/** Signed-in actors for API tests that mock `@/http/actor`'s `requestActor`. */
import { randomUUID } from "node:crypto";
import type { CaseKey } from "@/chat/types";
import type { DemoPersona } from "@/auth/schema";
import type { Actor } from "./identity";

/** A studio member. `persona` makes it the demo's Jordan, as a visitor's demo studio has. */
export function designerActor(studioId: string = randomUUID(), options: { persona?: DemoPersona; kind?: "real" | "demo" } = {}): Actor {
  return {
    userId: randomUUID(), authSessionId: randomUUID(), name: "Jordan Lee", email: "jordan@example.com", demoPersona: options.persona ?? null, role: "designer",
    studio: { id: studioId, name: "Lee Studio", role: "owner", kind: options.kind ?? (options.persona ? "demo" : "real") }, projects: [],
  };
}

/** A client of the given projects. `persona` makes it the demo's Emma. */
export function clientActor(studioId: string, keys: CaseKey[], options: { persona?: DemoPersona; name?: string } = {}): Actor {
  return {
    userId: randomUUID(), authSessionId: randomUUID(), name: options.name ?? "Emma Park", email: "emma@example.com", demoPersona: options.persona ?? null, role: "client", studio: null,
    projects: keys.map((key) => ({ studioId, caseId: randomUUID(), key })),
  };
}
