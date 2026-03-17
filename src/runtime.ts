import { BunServices } from "@effect/platform-bun"

import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"

import { AzureDevOpsService, FetchClient } from "./azure-devops"
import { makeReviewConfigLayer, RuntimeInput } from "./config"
import { GitService } from "./git"
import { OpenCodeService } from "./opencode"
import { ProcessRunner } from "./process"

export const makeAppLayer = (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => {
  const inputLayer = Layer.succeed(RuntimeInput, {
    argv,
    env,
  })
  const fetchLayer = Layer.succeed(FetchClient, { fetch: globalThis.fetch })
  const bunRuntimeLayer = Layer.mergeAll(BunServices.layer, inputLayer)
  const configLayer = makeReviewConfigLayer.pipe(Layer.provide(inputLayer))
  const processLayer = ProcessRunner.layer.pipe(Layer.provide(BunServices.layer))
  const gitLayer = GitService.layer.pipe(Layer.provide(Layer.mergeAll(processLayer, BunServices.layer)))
  const openCodeLayer = OpenCodeService.layer.pipe(Layer.provide(Layer.mergeAll(processLayer, bunRuntimeLayer)))
  const azureDevOpsLayer = AzureDevOpsService.layer.pipe(Layer.provide(fetchLayer))
  const loggerLayer = Logger.layer([Logger.consoleJson])

  return Layer.mergeAll(
    bunRuntimeLayer,
    fetchLayer,
    configLayer,
    processLayer,
    gitLayer,
    openCodeLayer,
    azureDevOpsLayer,
    loggerLayer,
  )
}
