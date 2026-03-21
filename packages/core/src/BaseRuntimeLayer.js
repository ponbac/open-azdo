import { BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import * as Logger from "effect/Logger"
export const BaseRuntimeLayer = Layer.mergeAll(BunServices.layer, Logger.layer([Logger.consoleJson]))
