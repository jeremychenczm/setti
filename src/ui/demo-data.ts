/** The demo studio's designer, who is signed in to the workspace, and money formatting. */

export type PersonRole = "designer" | "client";

export interface Person {
  id: string;
  name: string;
  role: PersonRole;
  /** Path under public/; people without one get a default from the avatar set. */
  avatar?: string;
}

export const me: Person = { id: "jordan", name: "Jordan Lee", role: "designer", avatar: "/avatars/designer.webp" };

export function usd(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}
