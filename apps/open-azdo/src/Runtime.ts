import { Layer } from "effect"
import { AzureDevOpsClientLive } from "@open-azdo/azdo/client"
import { makeBaseRuntimeLayer } from "@open-azdo/core/base-runtime"
import { GitExecLive } from "@open-azdo/core/git"
import { OpenCodeRunnerLive } from "@open-azdo/core/opencode"
import { ProcessRunnerLive } from "@open-azdo/core/process-runner"

import { makeAppConfigLayer, type ReviewCliInput } from "./AppConfig"
import { makeSandboxCaptureConfigLayer, type SandboxCaptureCliInput } from "./SandboxCaptureConfig"

const makePlatformRuntimeLayers = (jsonLogs: boolean) => {
  const baseRuntimeLayer = makeBaseRuntimeLayer({
    jsonLogs,
  })
  const processRunnerLayer = ProcessRunnerLive.pipe(Layer.provide(baseRuntimeLayer))
  const platformLayer = Layer.mergeAll(baseRuntimeLayer, processRunnerLayer)
  const gitExecLayer = GitExecLive.pipe(Layer.provide(processRunnerLayer))
  const openCodeRunnerLayer = OpenCodeRunnerLive.pipe(Layer.provide(platformLayer))

  return {
    appRuntimeLayer: Layer.mergeAll(platformLayer, gitExecLayer, AzureDevOpsClientLive, openCodeRunnerLayer),
  }
}

export const makeRuntimeLayer = (cliInput: ReviewCliInput): Layer.Layer<any, any, never> => {
  const appConfigLayer = makeAppConfigLayer(cliInput)
  const { appRuntimeLayer } = makePlatformRuntimeLayers(cliInput.json)

  return Layer.mergeAll(appRuntimeLayer, appConfigLayer)
}

export const makeSandboxCaptureRuntimeLayer = (cliInput: SandboxCaptureCliInput): Layer.Layer<any, any, never> => {
  const appConfigLayer = makeSandboxCaptureConfigLayer(cliInput)
  const { appRuntimeLayer } = makePlatformRuntimeLayers(cliInput.json)

  return Layer.mergeAll(appRuntimeLayer, appConfigLayer)
}
