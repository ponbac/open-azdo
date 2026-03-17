import { Effect } from "effect"

import { runCliWithExitHandling } from "./cli"
import { makeAppLayer } from "./runtime"

export const main = async (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  await Effect.runPromise(runCliWithExitHandling().pipe(Effect.provide(makeAppLayer(argv, env))))
