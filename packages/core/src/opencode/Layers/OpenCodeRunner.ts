import { Effect, Layer } from "effect"

import { OpenCodeOutputError } from "../../errors"
import { logInfo } from "../../Logging"
import { OpenCodeRunner, type OpenCodeRunRequest, type OpenCodeRunResult } from "../Services/OpenCodeRunner"
import { OpenCodeSdkRuntimeLive } from "../internal/Layers/OpenCodeSdkRuntime"
import {
  OPEN_CODE_STRUCTURED_OUTPUT_TOOL,
  OpenCodeSdkRuntime,
  type OpenCodeConfig,
  type OpenCodePermissionRule,
} from "../internal/Services/OpenCodeSdkRuntime"

const OPEN_CODE_CONFIG_SCHEMA = "https://opencode.ai/config.json"
type ParsedModel = {
  readonly providerID: string
  readonly modelID: string
}

const allow = (action: string, resource = "*"): OpenCodePermissionRule => ({ action, resource, effect: "allow" })

const OPEN_CODE_ALLOWED_SHELL_COMMANDS = [
  "git diff *",
  "git show *",
  "git log *",
  "git status *",
  "git rev-parse *",
  "rg *",
  "grep *",
  "find *",
  "ls *",
  "cat *",
  "sed *",
]

/**
 * Deny-by-default read-only rules. The leading catch-all also keeps headless
 * runs moving: V2 treats an unmatched request as `ask`, and nobody can answer.
 */
const openCodePermissions: ReadonlyArray<OpenCodePermissionRule> = [
  { action: "*", resource: "*", effect: "deny" },
  allow("read"),
  allow("glob"),
  allow("grep"),
  allow(OPEN_CODE_STRUCTURED_OUTPUT_TOOL),
  ...OPEN_CODE_ALLOWED_SHELL_COMMANDS.map((command) => allow("shell", command)),
]

export const buildOpenCodeConfig = (agentName: string): OpenCodeConfig => ({
  $schema: OPEN_CODE_CONFIG_SCHEMA,
  update: "disable",
  default_agent: agentName,
  agents: {
    [agentName]: {
      mode: "primary",
      description: "Read-only Azure DevOps pull request reviewer",
      permissions: openCodePermissions,
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

    yield* logInfo(`Preparing OpenCode execution for ${request.model}.`)

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
