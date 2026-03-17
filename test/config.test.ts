import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { inferOrganizationFromCollectionUrl, loadReviewConfig } from "../src/config"
import { makeBaseEnv } from "./helpers"

describe("config", () => {
  test("requires model and access token", async () => {
    const exit = await Effect.runPromiseExit(
      loadReviewConfig(["review"], {
        ...makeBaseEnv(),
        SYSTEM_ACCESSTOKEN: undefined,
      }),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("parses Azure DevOps Services collection URLs", () => {
    expect(inferOrganizationFromCollectionUrl("https://dev.azure.com/acme")).toBe("acme")
    expect(inferOrganizationFromCollectionUrl("https://dev.azure.com/acme/")).toBe("acme")
  })

  test("parses Azure DevOps Server collection URLs", () => {
    expect(inferOrganizationFromCollectionUrl("https://azdo.internal/tfs/DefaultCollection")).toBe("DefaultCollection")
    expect(inferOrganizationFromCollectionUrl("https://azdo.internal/Collection")).toBe("Collection")
  })

  test("loads a complete review config", async () => {
    const config = await Effect.runPromise(loadReviewConfig(["review", "--model", "openai/gpt-5.4"], makeBaseEnv()))

    expect(config.command).toBe("review")
    expect(config.model).toBe("openai/gpt-5.4")
    expect(config.opencodeVariant).toBeUndefined()
    expect(config.opencodeTimeoutMs).toBe(600000)
    expect(config.pullRequestId).toBe(42)
    expect(config.organization).toBe("acme")
  })

  test("loads an explicit OpenCode variant from the environment", async () => {
    const config = await Effect.runPromise(
      loadReviewConfig(["review", "--model", "openai/gpt-5.4"], {
        ...makeBaseEnv(),
        OPEN_AZDO_OPENCODE_VARIANT: "high",
      }),
    )

    expect(config.opencodeVariant).toBe("high")
  })

  test("prefers the CLI OpenCode variant over the environment", async () => {
    const config = await Effect.runPromise(
      loadReviewConfig(["review", "--model", "openai/gpt-5.4", "--opencode-variant", "minimal"], {
        ...makeBaseEnv(),
        OPEN_AZDO_OPENCODE_VARIANT: "high",
      }),
    )

    expect(config.opencodeVariant).toBe("minimal")
  })

  test("loads an explicit OpenCode timeout from the environment", async () => {
    const config = await Effect.runPromise(
      loadReviewConfig(["review", "--model", "openai/gpt-5.4"], {
        ...makeBaseEnv(),
        OPEN_AZDO_OPENCODE_TIMEOUT_MS: "450000",
      }),
    )

    expect(config.opencodeTimeoutMs).toBe(450000)
  })

  test("prefers the CLI OpenCode timeout over the environment", async () => {
    const config = await Effect.runPromise(
      loadReviewConfig(["review", "--model", "openai/gpt-5.4", "--opencode-timeout-ms", "600000"], {
        ...makeBaseEnv(),
        OPEN_AZDO_OPENCODE_TIMEOUT_MS: "450000",
      }),
    )

    expect(config.opencodeTimeoutMs).toBe(600000)
  })
})
