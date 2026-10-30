import { Effect, Layer } from "effect"
import { AzureDevOpsClientLive } from "@open-azdo/azdo/client"
import { BaseRuntimeLayer, JsonBaseRuntimeLayer } from "@open-azdo/core/base-runtime"
import { GitExecLive } from "@open-azdo/core/git"
import { OpenCodeRunnerLive } from "@open-azdo/core/opencode"
import { ProcessRunnerLive } from "@open-azdo/core/process-runner"

import { AppConfigLive, ReviewCommandInput } from "./AppConfig"
import { SandboxCaptureConfigLive, SandboxCaptureCommandInput } from "./SandboxCaptureConfig"

const makePlatformRuntimeLayer = (jsonLogs: boolean) => {
  const baseRuntimeLayer = jsonLogs ? JsonBaseRuntimeLayer : BaseRuntimeLayer

  const processRunnerLayer = ProcessRunnerLive.pipe(Layer.provide(baseRuntimeLayer))
  const platformLayer = Layer.mergeAll(baseRuntimeLayer, processRunnerLayer)
  const gitExecLayer = GitExecLive.pipe(Layer.provide(processRunnerLayer))
  const openCodeRunnerLayer = OpenCodeRunnerLive.pipe(Layer.provide(platformLayer))

  return Layer.mergeAll(platformLayer, gitExecLayer, AzureDevOpsClientLive, openCodeRunnerLayer)
}

/** Compose review settings and concrete adapters from the contextual command input. */
export const ReviewRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const input = yield* ReviewCommandInput

    return Layer.mergeAll(makePlatformRuntimeLayer(input.json), AppConfigLive)
  }),
)

/** Compose capture settings and concrete adapters from the contextual command input. */
export const SandboxCaptureRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const input = yield* SandboxCaptureCommandInput

    return Layer.mergeAll(makePlatformRuntimeLayer(input.json), SandboxCaptureConfigLive)
  }),
)
