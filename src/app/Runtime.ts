import { BunServices } from "@effect/platform-bun"

import { Layer } from "effect"
import * as Logger from "effect/Logger"

import { AzureDevOpsClientLive } from "../azdo/Layers/AzureDevOpsClient"
import { makeAppConfigLayer, type ReviewCliInput } from "../config/AppConfig"
import { GitExecLive } from "../git/Layers/GitExec"
import { OpenCodeRunnerLive } from "../opencode/Layers/OpenCodeRunner"
import { ProcessRunnerLive } from "../platform/Layers/ProcessRunner"

export const BaseRuntimeLayer = Layer.mergeAll(BunServices.layer, Logger.layer([Logger.consoleJson]))

export const makeRuntimeLayer = (cliInput: ReviewCliInput) => {
  const appConfigLayer = makeAppConfigLayer(cliInput)
  const processRunnerLayer = ProcessRunnerLive.pipe(Layer.provide(BaseRuntimeLayer))
  const platformLayer = Layer.mergeAll(BaseRuntimeLayer, processRunnerLayer)
  const gitExecLayer = GitExecLive.pipe(Layer.provide(processRunnerLayer))
  const openCodeRunnerLayer = OpenCodeRunnerLive.pipe(Layer.provide(platformLayer))

  return Layer.mergeAll(platformLayer, appConfigLayer, gitExecLayer, AzureDevOpsClientLive, openCodeRunnerLayer)
}
