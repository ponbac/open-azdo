import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

import * as Layer from "effect/Layer"
import * as ServiceMap from "effect/ServiceMap"
import * as Stream from "effect/Stream"
import { Effect, Option } from "effect"

import { CommandExecutionError } from "./errors"
import { logError, logInfo, truncateForLog } from "./logging"

export type CommandExecutionResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type ExecuteCommandInput = {
  operation: string
  command: string
  args: ReadonlyArray<string>
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
  maxOutputBytes?: number
  allowNonZeroExit?: boolean
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000

const summarizeArg = (arg: string) => {
  if (arg.includes("\n") || arg.length > 160) {
    return `[${arg.length} chars omitted]`
  }

  return truncateForLog(arg, 160)
}

const summarizeArgs = (args: ReadonlyArray<string>) => args.map(summarizeArg)

const commandLabel = (input: Pick<ExecuteCommandInput, "command" | "args">) =>
  [input.command, ...summarizeArgs(input.args)].join(" ")

const commandLogFields = (
  input: ExecuteCommandInput,
  timeoutMs: number,
  maxOutputBytes: number,
): Record<string, unknown> => ({
  operation: input.operation,
  command: input.command,
  args: summarizeArgs(input.args),
  cwd: input.cwd ?? "",
  timeoutMs,
  maxOutputBytes,
  allowNonZeroExit: input.allowNonZeroExit ?? false,
  stdinBytes: input.stdin?.length ?? 0,
})

const commandResultLogFields = (
  input: ExecuteCommandInput,
  timeoutMs: number,
  maxOutputBytes: number,
  result: CommandExecutionResult,
): Record<string, unknown> => ({
  ...commandLogFields(input, timeoutMs, maxOutputBytes),
  exitCode: result.exitCode,
  stdoutBytes: result.stdout.length,
  stderrBytes: result.stderr.length,
})

const toCommandExecutionError = (input: ExecuteCommandInput, detail: string, stderr = "", exitCode = -1) =>
  new CommandExecutionError({
    operation: input.operation,
    command: [input.command, ...summarizeArgs(input.args)],
    cwd: input.cwd ?? "",
    detail,
    stderr,
    exitCode,
  })

const collectOutput = Effect.fn("process.collectOutput")(function* (
  input: ExecuteCommandInput,
  stream: Stream.Stream<Uint8Array, unknown>,
  streamName: "stdout" | "stderr",
  maxOutputBytes: number,
) {
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""

  yield* Stream.runForEach(stream, (chunk) =>
    Effect.sync(() => {
      bytes += chunk.byteLength
      if (bytes > maxOutputBytes) {
        throw toCommandExecutionError(
          input,
          `${commandLabel(input)} ${streamName} exceeded ${maxOutputBytes} bytes.`,
          streamName === "stderr" ? text : "",
        )
      }

      text += decoder.decode(chunk, { stream: true })
    }),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof CommandExecutionError
        ? error
        : toCommandExecutionError(input, `Failed while collecting ${streamName}.`, streamName === "stderr" ? text : ""),
    ),
  )

  text += decoder.decode()
  return text
})

export class ProcessRunner extends ServiceMap.Service<
  ProcessRunner,
  {
    readonly execute: (input: ExecuteCommandInput) => Effect.Effect<CommandExecutionResult, CommandExecutionError>
  }
>()("open-azdo/ProcessRunner") {
  static readonly layer = Layer.effect(
    ProcessRunner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner

      const execute = Effect.fn("ProcessRunner.execute")(function* (input: ExecuteCommandInput) {
        const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
        const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
        const encodedStdin =
          input.stdin === undefined ? "ignore" : Stream.fromIterable([new TextEncoder().encode(input.stdin)])

        yield* logInfo("Starting command.", commandLogFields(input, timeoutMs, maxOutputBytes))

        const command = ChildProcess.make(input.command, [...input.args], {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.env ? { env: input.env, extendEnv: false } : {}),
          stdin: encodedStdin,
          stdout: "pipe",
          stderr: "pipe",
        })

        return yield* Effect.gen(function* () {
          const handle = yield* spawner
            .spawn(command)
            .pipe(
              Effect.mapError((error) =>
                toCommandExecutionError(input, `Failed to start ${commandLabel(input)}: ${String(error)}`),
              ),
            )

          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectOutput(input, handle.stdout, "stdout", maxOutputBytes),
              collectOutput(input, handle.stderr, "stderr", maxOutputBytes),
              handle.exitCode.pipe(
                Effect.map((value) => Number(value)),
                Effect.mapError(() =>
                  toCommandExecutionError(input, `Failed to read exit code for ${commandLabel(input)}.`),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          )

          if (exitCode !== 0 && !input.allowNonZeroExit) {
            return yield* toCommandExecutionError(
              input,
              stderr.trim().length > 0
                ? `${commandLabel(input)} failed: ${truncateForLog(stderr.trim())}`
                : `${commandLabel(input)} failed.`,
              stderr,
              exitCode,
            )
          }

          return {
            exitCode,
            stdout,
            stderr,
          } satisfies CommandExecutionResult
        }).pipe(
          Effect.scoped,
          Effect.timeoutOption(timeoutMs),
          Effect.flatMap((maybeResult) =>
            Option.match(maybeResult, {
              onNone: () =>
                Effect.fail(toCommandExecutionError(input, `${commandLabel(input)} timed out after ${timeoutMs}ms.`)),
              onSome: Effect.succeed,
            }),
          ),
          Effect.tap((result) =>
            logInfo("Command completed.", commandResultLogFields(input, timeoutMs, maxOutputBytes, result)),
          ),
          Effect.tapError((error) =>
            logError("Command failed.", {
              ...commandLogFields(input, timeoutMs, maxOutputBytes),
              detail: error.detail,
              exitCode: error.exitCode,
              stderrPreview: truncateForLog(error.stderr || error.detail),
            }),
          ),
          Effect.withLogSpan(input.operation),
        )
      })

      return ProcessRunner.of({
        execute,
      })
    }),
  )
}
