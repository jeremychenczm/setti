/** Portraits in public/avatars. */
export const AVATARS = [
  "designer",
  "client",
  "project-manager",
  "supplier",
  "budget-manager",
  "contractor",
  "consultant",
  "report-specialist",
].map((name) => `/avatars/${name}.webp`);

/** The person's chosen avatar, or one picked from their id so it stays the same on every render. */
export function avatarFor(person: { id: string; avatar?: string }): string {
  if (person.avatar) return person.avatar;
  let hash = 0;
  for (const char of person.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATARS[hash % AVATARS.length];
}
