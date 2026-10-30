import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

import { ProcessRunner, ProcessRunnerLive } from "@open-azdo/core/process-runner"
import { CommandExecutionError } from "@open-azdo/core/errors"

import { withSilentLogs } from "./helpers"

describe("process runner", () => {
  test.each(["stdout", "stderr"] as const)(
    "reports the %s byte limit as a recoverable command failure",
    async (stream) => {
      const execute = (maxOutputBytes: number) =>
        Effect.gen(function* () {
          const runner = yield* ProcessRunner

          return yield* runner.execute({
            operation: "test.outputLimit",
            command: process.execPath,
            args: ["-e", `process.${stream}.write('éé')`],
            maxOutputBytes,
          })
        }).pipe(Effect.provide(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer))), withSilentLogs)

      const result = await Effect.runPromise(execute(4))
      expect(result[stream]).toBe("éé")

      const failure = await Effect.runPromise(execute(3).pipe(Effect.flip))
      expect(failure).toBeInstanceOf(CommandExecutionError)
      expect(failure.detail).toContain(`${stream} exceeded 3 bytes`)
    },
  )
})
