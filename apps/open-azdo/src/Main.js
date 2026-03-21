import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Effect } from "effect"
import * as Command from "effect/unstable/cli/Command"
import { BaseRuntimeLayer } from "@open-azdo/core/base-runtime"
import { openAzdoCli } from "./Cli"
import { version } from "../package.json" with { type: "json" }
export const cliProgram = Command.run(openAzdoCli, { version }).pipe(Effect.scoped, Effect.provide(BaseRuntimeLayer))
export const main = () => BunRuntime.runMain(cliProgram, { disableErrorReporting: true })
