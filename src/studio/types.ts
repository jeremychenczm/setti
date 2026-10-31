import type { CaseMessage } from "@/chat/types";

export interface StudioThreadSnapshot {
  projectId: string;
  messages: CaseMessage[];
  readOnly: boolean;
  aiConfigured: boolean;
}
