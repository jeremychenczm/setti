/** Why the studio cancelled an approved item before it was charged, and how each reason reads. Shared by the server and the page. */
export const CANCELLATION_REASONS = ["unavailable", "no_response", "client_asked", "other"] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export const CANCELLATION_REASON_TEXT: Record<CancellationReason, string> = {
  unavailable: "Out of stock or discontinued",
  no_response: "Supplier didn't respond",
  client_asked: "Client asked to cancel",
  other: "Other",
};
