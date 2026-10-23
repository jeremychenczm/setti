export class PricingStoreError extends Error {
  constructor(readonly code: string, message: string, readonly problems?: string[]) {
    super(message);
    this.name = "PricingStoreError";
  }
}
