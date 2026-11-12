/**
 * A sent version's name wherever people read it: the project and the version.
 * The AI draft's own title is never shown, because it grows with every change.
 */
export function quoteTitle(order: { projectName: string; version: number }): string {
  return `${order.projectName} · Quote V${order.version}`;
}
