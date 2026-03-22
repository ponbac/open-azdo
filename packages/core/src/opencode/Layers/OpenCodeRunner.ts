import type { Config } from "@opencode-ai/sdk/v2"

import { Effect, Layer } from "effect"

import { OpenCodeOutputError } from "../../errors"
import { logInfo, truncateForLog } from "../../Logging"
import { OpenCodeRunner, type OpenCodeRunRequest, type OpenCodeRunResult } from "../Services/OpenCodeRunner"
import { OpenCodeSdkRuntimeLive } from "../internal/Layers/OpenCodeSdkRuntime"
import { OpenCodeSdkRuntime } from "../internal/Services/OpenCodeSdkRuntime"

const OPEN_CODE_CONFIG_SCHEMA = "https://opencode.ai/config.json"
const OPENAI_DIRECT_PROVIDER_ID = "openai-direct"
const OPENAI_DIRECT_MODEL_REGEXP = /^gpt-5(?:\.\d+)?-(?:mini|nano)$/

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

const usesOpenAIDirectProvider = (model: ParsedModel) =>
  model.providerID === "openai" && OPENAI_DIRECT_MODEL_REGEXP.test(model.modelID)

const toOpenCodeModel = (model: ParsedModel): ParsedModel =>
  usesOpenAIDirectProvider(model)
    ? {
        providerID: OPENAI_DIRECT_PROVIDER_ID,
        modelID: model.modelID,
      }
    : model

export const buildOpenCodeConfig = (agentName: string, model?: ParsedModel): Config => ({
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
  ...(model && usesOpenAIDirectProvider(model)
    ? {
        provider: {
          [OPENAI_DIRECT_PROVIDER_ID]: {
            id: OPENAI_DIRECT_PROVIDER_ID,
            name: "OpenAI Direct",
            npm: "@ai-sdk/openai",
            env: ["OPENAI_API_KEY"],
            models: {
              [model.modelID]: {
                id: model.modelID,
                name: model.modelID,
                family: model.modelID,
                attachment: false,
                reasoning: true,
                temperature: true,
                tool_call: true,
                release_date: "2025-08-07",
                modalities: {
                  input: ["text", "image"],
                  output: ["text"],
                },
                cost: {
                  input: 0,
                  output: 0,
                },
                limit: {
                  context: 400_000,
                  output: 128_000,
                },
              },
            },
          },
        },
      }
    : {}),
})

const parseModel = (model: string) => {
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
    const effectiveModel = toOpenCodeModel(model)
    const config = buildOpenCodeConfig(request.agent, model)

    yield* logInfo("Preparing OpenCode execution.", {
      agent: request.agent,
      model: request.model,
      effectiveModel: `${effectiveModel.providerID}/${effectiveModel.modelID}`,
      workspace: request.workspace,
      variant: request.variant,
      promptChars: request.prompt.length,
      structuredRequested: request.format?.type === "json_schema",
    })

    const result = yield* sdkRuntime.prompt({
      workspace: request.workspace,
      model: effectiveModel,
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
