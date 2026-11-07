import { STUDIO_CASES } from "@/demo/studio-cases";

/** Soft backgrounds with a readable ink, in the portraits' palette. */
export const MONOGRAM_TONES = [
  { background: "#f9dcc4", ink: "#7a3d12" },
  { background: "#cfe3f6", ink: "#1f4b75" },
  { background: "#d6ecd0", ink: "#2f5d27" },
  { background: "#e6dbf6", ink: "#55348a" },
  { background: "#fbe7a8", ink: "#6b4e05" },
  { background: "#f6d2dc", ink: "#86304b" },
  { background: "#cdebe6", ink: "#1f5b52" },
  { background: "#e9e4d8", ink: "#4f4a3c" },
] as const;

// Each prepared project's client keeps its own tone, so no two in the studio look alike.
const STUDIO_TONES = new Map(STUDIO_CASES.map((project, index) => [project.id, index % MONOGRAM_TONES.length]));

function hashed(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/** The person's own portrait, if they have one. People without one get a monogram instead of a borrowed face. */
export function avatarFor(person: { id: string; avatar?: string }): string | null {
  return person.avatar ?? null;
}

/** Initials on a tone that stays the same for the person on every render. */
export function monogramFor(person: { id: string; name: string }): { initials: string; background: string; ink: string } {
  const words = person.name.trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  const tone = MONOGRAM_TONES[STUDIO_TONES.get(person.id) ?? hashed(person.id) % MONOGRAM_TONES.length];
  return { initials, ...tone };
}
