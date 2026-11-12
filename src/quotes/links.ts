/** Where a project's quote lives: its page, or one of its versions, optionally at an anchor on it. */
export function quoteHref(projectKey: string, version?: number | null, anchor?: string): string {
  return `/quotes/${encodeURIComponent(projectKey)}${version ? `?v=${version}` : ""}${anchor ? `#${anchor}` : ""}`;
}
