import type { CaseKey } from "@/chat/types";
import type { Person } from "../demo-data";
import { Avatar } from "./primitives";

export interface ProjectChat<Key extends string = CaseKey> {
  key: Key;
  title: string;
  subtitle: string;
  /** The other person in the chat: the client for the designer, the designer for a client. */
  counterpart: Person;
}

export function ConversationList<Key extends string>({ projects, activeId, onOpen }: { projects: ProjectChat<Key>[]; activeId: Key; onOpen: (key: Key) => void }) {
  return (
    <section className="flex w-[300px] shrink-0 flex-col rounded-xl bg-white shadow-sm">
      <h2 className="px-4 pb-2 pt-3 text-base font-semibold">Chats</h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {projects.map((project) => (
          <button
            key={project.key}
            onClick={() => onOpen(project.key)}
            aria-current={project.key === activeId ? "page" : undefined}
            className={`flex w-full gap-3 rounded-lg px-2 py-2.5 text-left ${project.key === activeId ? "bg-[var(--primary-soft)]" : "hover:bg-[var(--canvas)]"}`}
          >
            <Avatar person={project.counterpart} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold">{project.title}</span>
                <span className="truncate text-[11px] text-[var(--muted)]">{project.subtitle}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-[var(--muted)]">Project chat with {project.counterpart.name} · AI drafts on request</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
