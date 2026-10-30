import { BunServices } from "@effect/platform-bun"

import { Layer } from "effect"
import { JsonLoggerLayer, PrettyLoggerLayer } from "./Logging"

/**
 * Shared Bun platform runtime with human-readable operational logs on stderr.
 */
export const BaseRuntimeLayer = Layer.mergeAll(BunServices.layer, PrettyLoggerLayer)

/** Shared Bun platform runtime with machine-readable operational logs on stderr. */
export const JsonBaseRuntimeLayer = Layer.mergeAll(BunServices.layer, JsonLoggerLayer)
