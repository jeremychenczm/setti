/** Studio names and slugs, shared by the sign-up page and the server. */

/** The studio a designer starts with when the sign-up leaves its name blank; the owner can rename it. */
export function defaultStudioName(userName: string): string {
  return `${userName.trim()}'s studio`;
}

/** A unique, unguessable slug: studios are found by id, never by slug. */
export function newStudioSlug(): string {
  return `studio-${globalThis.crypto.randomUUID()}`;
}
