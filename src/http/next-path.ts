/** A path on this site to go to next, or null when `value` could lead anywhere else. */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  try {
    const url = new URL(value, "http://setti.invalid");
    return url.origin === "http://setti.invalid" ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch { return null; }
}
