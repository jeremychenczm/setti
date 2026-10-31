"use client";

import { DesignerProjects } from "./DesignerProjects";

export function StudioProjectsModule({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  return <DesignerProjects onOpenProject={onOpenProject} />;
}
