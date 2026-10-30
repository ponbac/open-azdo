import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import * as ConfigProvider from "effect/ConfigProvider"
import { Effect, Layer, Option, Result } from "effect"
import * as Duration from "effect/Duration"

import { inferOrganizationFromCollectionUrl } from "../src/AppConfig"
import { ConfigError } from "../src/errors"
import {
  SandboxCaptureConfig,
  SandboxCaptureConfigLive,
  SandboxCaptureCommandInput,
  type SandboxCaptureCliInput,
} from "../src/SandboxCaptureConfig"
import { makeBaseEnv, makeReviewCliInput, resolveAppConfig } from "./helpers"

describe("config", () => {
  const sandboxEnvironment = {
    OPEN_AZDO_LIVE_MODEL: "openai/gpt-5.4",
    OPEN_AZDO_LIVE_COLLECTION_URL: "https://dev.azure.com/acme",
    OPEN_AZDO_LIVE_ORGANIZATION: "acme",
    OPEN_AZDO_LIVE_PROJECT: "project",
    OPEN_AZDO_LIVE_REPOSITORY_ID: "repo-1",
    OPEN_AZDO_LIVE_PULL_REQUEST_ID: "42",
    OPEN_AZDO_LIVE_ACCESS_TOKEN: "system-token",
  }

  const makeSandboxCaptureCliInput = (overrides: Partial<SandboxCaptureCliInput> = {}): SandboxCaptureCliInput => ({
    model: Option.none(),
    opencodeVariant: Option.none(),
    opencodeTimeout: Option.none(),
    workspace: Option.none(),
    organization: Option.none(),
    project: Option.none(),
    repositoryId: Option.none(),
    pullRequestId: Option.none(),
    collectionUrl: Option.none(),
    output: Option.none(),
    json: false,
    ...overrides,
  })

  const resolveSandboxCaptureConfig = (cliInput: SandboxCaptureCliInput, env: Record<string, string | undefined>) =>
    Effect.gen(function* () {
      return yield* SandboxCaptureConfig
    }).pipe(
      Effect.provide(
        SandboxCaptureConfigLive.pipe(
          Layer.provide(Layer.succeed(SandboxCaptureCommandInput, cliInput)),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: Object.fromEntries(
                  Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
                ),
              }),
            ),
          ),
        ),
      ),
    )

  test.each([
    { name: "model", model: Option.none<string>(), token: "system-token", issue: "model" },
    {
      name: "system access token",
      model: Option.some("openai/gpt-5.4"),
      token: undefined,
      issue: "systemAccessToken",
    },
  ])("requires a $name", async ({ model, token, issue }) => {
    const result = await resolveAppConfig(makeReviewCliInput({ model }), {
      ...makeBaseEnv(),
      SYSTEM_ACCESSTOKEN: token,
    }).pipe(Effect.result, Effect.runPromise)

    expect(Result.isFailure(result)).toBe(true)

    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ConfigError)

      if (result.failure instanceof ConfigError) {
        expect(result.failure.issues.join(" ")).toContain(issue)
      }
    }
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
    expect(config.sourceCommitId).toBeUndefined()
  })

  test("loads the pull request source commit id when available", async () => {
    const config = await Effect.runPromise(
      resolveAppConfig(
        makeReviewCliInput({
          model: Option.some("openai/gpt-5.4"),
        }),
        {
          ...makeBaseEnv(),
          SYSTEM_PULLREQUEST_SOURCECOMMITID: "1234567890abcdef",
        },
      ),
    )

    expect(config.sourceCommitId).toBe("1234567890abcdef")
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

  test("writes sandbox captures under the repo-root .captures directory by default", async () => {
    const config = await Effect.runPromise(
      resolveSandboxCaptureConfig(makeSandboxCaptureCliInput(), sandboxEnvironment),
    )

    const repositoryRoot = resolve(import.meta.dir, "../../..")

    expect(config.output).toBe(join(repositoryRoot, ".captures", "acme-project-pr-42.json"))
  })

  test.each([
    { name: "missing model", key: "OPEN_AZDO_LIVE_MODEL", value: undefined, issue: "OPEN_AZDO_LIVE_MODEL" },
    {
      name: "invalid PR id",
      key: "OPEN_AZDO_LIVE_PULL_REQUEST_ID",
      value: "0",
      issue: "OPEN_AZDO_LIVE_PULL_REQUEST_ID",
    },
    { name: "unsafe PR id", key: "OPEN_AZDO_LIVE_PULL_REQUEST_ID", value: "9007199254740992", issue: "pullRequestId" },
  ])("returns a typed configuration failure for $name", async ({ key, value, issue }) => {
    const result = await resolveSandboxCaptureConfig(makeSandboxCaptureCliInput(), {
      ...sandboxEnvironment,
      [key]: value,
    }).pipe(Effect.result, Effect.runPromise)

    expect(Result.isFailure(result)).toBe(true)

    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ConfigError)
      expect(result.failure.issues.join(" ")).toContain(issue)
    }
  })
})
