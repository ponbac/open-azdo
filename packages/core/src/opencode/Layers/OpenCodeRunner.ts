import type { Config } from "@opencode-ai/sdk/v2"

import { Effect, Layer } from "effect"

import { OpenCodeOutputError } from "../../errors"
import { logInfo, truncateForLog } from "../../Logging"
import { OpenCodeRunner, type OpenCodeRunRequest, type OpenCodeRunResult } from "../Services/OpenCodeRunner"
import { OpenCodeSdkRuntimeLive } from "../internal/Layers/OpenCodeSdkRuntime"
import { OpenCodeSdkRuntime } from "../internal/Services/OpenCodeSdkRuntime"

const OPEN_CODE_CONFIG_SCHEMA = "https://opencode.ai/config.json"

type ParsedModel = {
  readonly providerID: string
  readonly modelID: string
}

const openCodePermission = {
  edit: "deny",
  read: "allow",
  grep: "allow",
  list: "allow",
  glob: "allow",
  webfetch: "deny",
  websearch: "deny",
  codesearch: "deny",
  bash: {
    "*": "deny",
    "git diff *": "allow",
    "git show *": "allow",
    "git log *": "allow",
    "git status *": "allow",
    "git rev-parse *": "allow",
    "rg *": "allow",
    "grep *": "allow",
    "find *": "allow",
    "ls *": "allow",
    "cat *": "allow",
    "sed *": "allow",
  },
} as const

export const buildOpenCodeConfig = (agentName: string): Config => ({
  $schema: OPEN_CODE_CONFIG_SCHEMA,
  share: "disabled",
  autoupdate: false,
  default_agent: agentName,
  permission: openCodePermission,
  agent: {
    [agentName]: {
      mode: "primary",
      description: "Read-only Azure DevOps pull request reviewer",
      permission: {
        edit: "deny",
        webfetch: "deny",
        websearch: "deny",
        codesearch: "deny",
      },
    },
  },
})

const parseModel = (model: string): Effect.Effect<ParsedModel, OpenCodeOutputError> => {
  const separatorIndex = model.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
    return Effect.fail(
      new OpenCodeOutputError({
        message: "OpenCode model must use the format provider/<model-id>.",
        output: model,
      }),
    )
  }

  return Effect.succeed({
    providerID: model.slice(0, separatorIndex),
    modelID: model.slice(separatorIndex + 1),
  })
}

const makeOpenCodeRunner = Effect.gen(function* () {
  const sdkRuntime = yield* OpenCodeSdkRuntime

  const run = Effect.fn("OpenCodeRunner.run")(function* (request: OpenCodeRunRequest) {
    const model = yield* parseModel(request.model)
    const config = buildOpenCodeConfig(request.agent)

    yield* logInfo("Preparing OpenCode execution.", {
      agent: request.agent,
      model: request.model,
      workspace: request.workspace,
      variant: request.variant,
      promptChars: request.prompt.length,
      structuredRequested: request.format?.type === "json_schema",
    })

    const result = yield* sdkRuntime.prompt({
      workspace: request.workspace,
      model,
      agent: request.agent,
      variant: request.variant,
      timeout: request.timeout,
      prompt: request.prompt,
      inheritedEnv: request.inheritedEnv,
      format: request.format,
      config,
    })

    yield* logInfo("Received OpenCode response.", {
      responseChars: result.response.length,
      responsePreview: truncateForLog(result.response),
      sessionId: result.sessionId,
      costUsd: result.usage?.costUsd,
      inputTokens: result.usage?.tokens?.input,
      outputTokens: result.usage?.tokens?.output,
      structuredDelivered: result.structured !== undefined,
      structuredErrorName: result.modelError?.name,
      structuredErrorRetries: result.modelError?.retries,
    })

    return {
      response: result.response,
      ...(result.structured !== undefined ? { structured: result.structured } : {}),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.modelError ? { modelError: result.modelError } : {}),
    } satisfies OpenCodeRunResult
  })

  return {
    run,
  }
})

export const OpenCodeRunnerLayer = Layer.effect(OpenCodeRunner, makeOpenCodeRunner)

export const OpenCodeRunnerLive = OpenCodeRunnerLayer.pipe(Layer.provideMerge(OpenCodeSdkRuntimeLive))
