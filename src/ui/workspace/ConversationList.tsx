import type { ReactNode } from "react";
import type { CaseKey } from "@/chat/types";
import type { Person } from "../demo-data";
import { Avatar } from "./primitives";

/** The latest message of a chat, as the list shows it. */
export interface ChatPreview {
  /** "You", or the sender's first name. */
  from: string;
  text: string;
  at: string;
}

export interface ProjectChat<Key extends string = CaseKey> {
  key: Key;
  title: string;
  subtitle: string;
  /** The other person in the chat: the client for the designer, the designer for a client. */
  counterpart: Person;
  preview?: ChatPreview | null;
}

/** Today's messages by time, older ones by date, as in a messaging app. */
export function previewTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** `top` sits above the chats, as the designer's reminders do; `action` beside the heading, as a new project does. */
export function ConversationList<Key extends string>({ projects, activeId, onOpen, top, action }: { projects: ProjectChat<Key>[]; activeId: Key | null; onOpen: (key: Key) => void; top?: ReactNode; action?: ReactNode }) {
  return (
    <section aria-label="Chats" className="flex w-[296px] shrink-0 flex-col">
      {top}
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4"><h2 className="text-[15px] font-semibold">Chats</h2>{action}</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {projects.map((project) => (
          <button
            key={project.key}
            onClick={() => onOpen(project.key)}
            aria-current={project.key === activeId ? "page" : undefined}
            className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left ${project.key === activeId ? "bg-[var(--primary-soft)]" : "hover:bg-[var(--canvas)]"}`}
          >
            <Avatar person={project.counterpart} size="lg" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{project.title}</span>
                {project.preview && <time dateTime={project.preview.at} className="shrink-0 text-[10px] text-[var(--muted)]">{previewTime(project.preview.at)}</time>}
              </span>
              <span className="mt-0.5 block truncate text-[12px] text-[var(--muted)]">
                {project.preview ? `${project.preview.from}: ${project.preview.text}` : project.counterpart.name === project.title ? project.subtitle : [project.counterpart.name, project.subtitle].filter(Boolean).join(" · ")}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
