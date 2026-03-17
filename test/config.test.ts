import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import * as Duration from "effect/Duration"

import { inferOrganizationFromCollectionUrl } from "../src/config/AppConfig"
import { makeBaseEnv, makeReviewCliInput, resolveAppConfig } from "./helpers"

describe("config", () => {
  test("requires a model and system access token", async () => {
    const exit = await Effect.runPromiseExit(
      resolveAppConfig(makeReviewCliInput(), {
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
    const config = await Effect.runPromise(
      resolveAppConfig(
        makeReviewCliInput({
          model: Option.some("openai/gpt-5.4"),
        }),
        makeBaseEnv(),
      ),
    )

    expect(config.command).toBe("review")
    expect(String(config.model)).toBe("openai/gpt-5.4")
    expect(config.opencodeVariant).toBeUndefined()
    expect(Duration.toMillis(config.opencodeTimeout)).toBe(600_000)
    expect(Number(config.pullRequestId)).toBe(42)
    expect(config.organization).toBe("acme")
  })

  test("prefers OPEN_AZDO_* over Azure Pipelines defaults", async () => {
    const config = await Effect.runPromise(
      resolveAppConfig(
        makeReviewCliInput({
          model: Option.some("openai/gpt-5.4"),
        }),
        {
          ...makeBaseEnv(),
          OPEN_AZDO_OPENCODE_VARIANT: "high",
          OPEN_AZDO_OPENCODE_TIMEOUT: "5 minutes",
          OPEN_AZDO_COLLECTION_URL: "https://dev.azure.com/custom",
        },
      ),
    )

    expect(config.opencodeVariant).toBe("high")
    expect(Duration.toMillis(config.opencodeTimeout)).toBe(300_000)
    expect(String(config.collectionUrl)).toBe("https://dev.azure.com/custom")
    expect(config.organization).toBe("custom")
  })

  test("prefers CLI flags over OPEN_AZDO_* values", async () => {
    const config = await Effect.runPromise(
      resolveAppConfig(
        makeReviewCliInput({
          model: Option.some("openai/gpt-5.4"),
          opencodeVariant: Option.some("minimal"),
          opencodeTimeout: Option.some("1 hour"),
          collectionUrl: Option.some("https://dev.azure.com/cli-org"),
          organization: Option.some("cli-org"),
        }),
        {
          ...makeBaseEnv(),
          OPEN_AZDO_OPENCODE_VARIANT: "high",
          OPEN_AZDO_OPENCODE_TIMEOUT: "5 minutes",
          OPEN_AZDO_COLLECTION_URL: "https://dev.azure.com/env-org",
          OPEN_AZDO_ORGANIZATION: "env-org",
        },
      ),
    )

    expect(config.opencodeVariant).toBe("minimal")
    expect(Duration.toMillis(config.opencodeTimeout)).toBe(3_600_000)
    expect(String(config.collectionUrl)).toBe("https://dev.azure.com/cli-org")
    expect(config.organization).toBe("cli-org")
  })

  test("rejects bare numeric OpenCode timeout values", async () => {
    const exit = await Effect.runPromiseExit(
      resolveAppConfig(
        makeReviewCliInput({
          model: Option.some("openai/gpt-5.4"),
          opencodeTimeout: Option.some("300"),
        }),
        makeBaseEnv(),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("rejects zero OpenCode timeout values", async () => {
    const exit = await Effect.runPromiseExit(
      resolveAppConfig(
        makeReviewCliInput({
          model: Option.some("openai/gpt-5.4"),
          opencodeTimeout: Option.some("0 seconds"),
        }),
        makeBaseEnv(),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("rejects negative OpenCode timeout values", async () => {
    const exit = await Effect.runPromiseExit(
      resolveAppConfig(
        makeReviewCliInput({
          model: Option.some("openai/gpt-5.4"),
          opencodeTimeout: Option.some("-1 hour"),
        }),
        makeBaseEnv(),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("rejects invalid collection urls", async () => {
    const exit = await Effect.runPromiseExit(
      resolveAppConfig(
        makeReviewCliInput({
          model: Option.some("openai/gpt-5.4"),
          collectionUrl: Option.some("notaurl"),
        }),
        makeBaseEnv(),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })
})
