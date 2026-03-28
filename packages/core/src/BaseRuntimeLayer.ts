import { BunServices } from "@effect/platform-bun"

import { Layer } from "effect"
import * as Logger from "effect/Logger"

import { makeRuntimeLogger } from "./Logging"

/**
 * Builds the shared Bun platform runtime with the selected operational logger.
 */
export const makeBaseRuntimeLayer = ({ jsonLogs }: { readonly jsonLogs: boolean }) =>
  Layer.mergeAll(
    BunServices.layer,
    Logger.layer([makeRuntimeLogger(jsonLogs)]),
    Layer.succeed(Logger.LogToStderr)(true),
  )

export const BaseRuntimeLayer = makeBaseRuntimeLayer({
  jsonLogs: false,
})
