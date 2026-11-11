/** A project as the workspace shows it, read on the server for the signed-in viewer. */
import type { CaseKey } from "@/chat/types";
import type { QuoteDocument } from "@/quotes/types";

export interface ProjectPerson {
  id: string;
  name: string;
  role: "designer" | "client";
  avatar?: string;
}

export interface ProjectSummary {
  key: CaseKey;
  name: string;
  subtitle: string;
  /** The studio that runs the project; empty for a session from before studios. */
  studio: string;
  /** The project's own V1, shown until the chat's saved state arrives. */
  quote: QuoteDocument;
  /** The studio's designer the project's chat is with. */
  designer: ProjectPerson;
  /** The project's client: the account added to it, else the person its quote names; null before either. */
  client: ProjectPerson | null;
  /** Whether a client's account has joined the project, so no invite link is needed. */
  clientJoined: boolean;
}
