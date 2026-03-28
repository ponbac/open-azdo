import { describe, expect, test } from "bun:test"

import { lookupModelPricing } from "@open-azdo/core/model-pricing"

import {
  MODELS_DEV_SOURCE_URL,
  normalizeModelsDevPricingSnapshot,
} from "../src/model-pricing/internal/ModelsDevPricingSnapshot"

describe("model pricing", () => {
  test("looks up vendored pricing for openai gpt-5.4-mini", () => {
    expect(lookupModelPricing("openai", "gpt-5.4-mini")).toEqual({
      input: 0.75,
      output: 4.5,
      cacheRead: 0.075,
    })
  })

  test("looks up vendored pricing for openai gpt-5.4-nano", () => {
    expect(lookupModelPricing("openai", "gpt-5.4-nano")).toEqual({
      input: 0.2,
      output: 1.25,
      cacheRead: 0.02,
    })
  })

  test("returns undefined for unknown model ids", () => {
    expect(lookupModelPricing("openai", "gpt-5.3-mini")).toBeUndefined()
  })

  test("normalizes the provider-keyed models.dev payload into the compact snapshot", () => {
    const snapshot = normalizeModelsDevPricingSnapshot(
      {
        openai: {
          models: {
            "gpt-5.4-mini": {
              cost: {
                input: 0.75,
                output: 4.5,
                cache_read: 0.075,
              },
            },
            "gpt-5.4-nano": {
              cost: {
                input: 0.2,
                output: 1.25,
                cache_read: 0.02,
                cache_write: 0.04,
              },
            },
            "gpt-missing-output": {
              cost: {
                input: 1,
              },
            },
          },
        },
        anthropic: {
          models: {
            "claude-4": {
              cost: {
                input: 3,
                output: 15,
              },
            },
          },
        },
        empty: {
          models: {},
        },
      },
      "2026-03-28T10:00:00.000Z",
    )

    expect(snapshot).toEqual({
      source: "models.dev",
      sourceUrl: MODELS_DEV_SOURCE_URL,
      generatedAt: "2026-03-28T10:00:00.000Z",
      providers: {
        anthropic: {
          "claude-4": {
            input: 3,
            output: 15,
          },
        },
        openai: {
          "gpt-5.4-mini": {
            input: 0.75,
            output: 4.5,
            cacheRead: 0.075,
          },
          "gpt-5.4-nano": {
            input: 0.2,
            output: 1.25,
            cacheRead: 0.02,
            cacheWrite: 0.04,
          },
        },
      },
    })
  })
})
