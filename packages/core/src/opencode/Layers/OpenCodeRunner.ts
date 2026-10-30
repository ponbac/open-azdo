import { Effect, Layer } from "effect"

import { OpenCodeOutputError } from "../../errors"
import { logInfo } from "../../Logging"
import { OpenCodeRunner, type OpenCodeRunRequest } from "../Services/OpenCodeRunner"
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

/**
 * Keep native capabilities explicit while allowing shell-based inspection and verification.
 * The leading catch-all avoids unattended permission prompts for unrelated native tools.
 */
const openCodePermissions: ReadonlyArray<OpenCodePermissionRule> = [
  { action: "*", resource: "*", effect: "deny" },
  allow("read"),
  allow("glob"),
  allow("grep"),
  allow("shell"),
  allow("external_directory"),
  allow("skill"),
  allow(OPEN_CODE_STRUCTURED_OUTPUT_TOOL),
]

/** Build the per-run configuration with only the reviewer agent and deny-by-default permissions. */
export const buildOpenCodeConfig = (agentName: string): OpenCodeConfig => ({
  $schema: OPEN_CODE_CONFIG_SCHEMA,
  update: "disable",
  default_agent: agentName,
  agents: {
    [agentName]: {
      mode: "primary",
      description: "Azure DevOps pull request reviewer with shell verification",
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

    return result
  })

  return {
    run,
  }
})

export const OpenCodeRunnerLayer = Layer.effect(OpenCodeRunner, makeOpenCodeRunner)

export const OpenCodeRunnerLive = OpenCodeRunnerLayer.pipe(Layer.provideMerge(OpenCodeSdkRuntimeLive))
