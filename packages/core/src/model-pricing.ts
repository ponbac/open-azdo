import { modelsDevPricingSnapshot } from "./model-pricing/generated/models-dev-pricing-snapshot"

export type { ModelPricing, PricingSnapshot } from "./model-pricing/internal/ModelsDevPricingSnapshot"

/**
 * Look up vendored token pricing for a provider/model pair. This stays
 * synchronous because the snapshot is generated ahead of time and checked in.
 */
export const lookupModelPricing = (providerID: string, modelID: string) =>
  modelsDevPricingSnapshot.providers[providerID]?.[modelID]
