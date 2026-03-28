import { Layer } from "effect"
import { AzureDevOpsClientLive } from "@open-azdo/azdo/client"
import { BaseRuntimeLayer } from "@open-azdo/core/base-runtime"
import { GitExecLive } from "@open-azdo/core/git"
import { OpenCodeRunnerLive } from "@open-azdo/core/opencode"
import { ProcessRunnerLive } from "@open-azdo/core/process-runner"

import { makeAppConfigLayer, type ReviewCliInput } from "./AppConfig"
import { makeSandboxCaptureConfigLayer, type SandboxCaptureCliInput } from "./SandboxCaptureConfig"

export const makeRuntimeLayer = (cliInput: ReviewCliInput): Layer.Layer<any, any, never> => {
  const appConfigLayer = makeAppConfigLayer(cliInput)
  const processRunnerLayer = ProcessRunnerLive.pipe(Layer.provide(BaseRuntimeLayer))
  const platformLayer = Layer.mergeAll(BaseRuntimeLayer, processRunnerLayer)
  const gitExecLayer = GitExecLive.pipe(Layer.provide(processRunnerLayer))
  const openCodeRunnerLayer = OpenCodeRunnerLive.pipe(Layer.provide(platformLayer))

  return Layer.mergeAll(platformLayer, appConfigLayer, gitExecLayer, AzureDevOpsClientLive, openCodeRunnerLayer)
}

export const makeSandboxCaptureRuntimeLayer = (cliInput: SandboxCaptureCliInput): Layer.Layer<any, any, never> => {
  const appConfigLayer = makeSandboxCaptureConfigLayer(cliInput)
  const processRunnerLayer = ProcessRunnerLive.pipe(Layer.provide(BaseRuntimeLayer))
  const platformLayer = Layer.mergeAll(BaseRuntimeLayer, processRunnerLayer)
  const gitExecLayer = GitExecLive.pipe(Layer.provide(processRunnerLayer))
  const openCodeRunnerLayer = OpenCodeRunnerLive.pipe(Layer.provide(platformLayer))

  return Layer.mergeAll(platformLayer, appConfigLayer, gitExecLayer, AzureDevOpsClientLive, openCodeRunnerLayer)
}
