import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

import { Effect, Layer, Option, Stream } from "effect"
import * as Duration from "effect/Duration"

import { CommandExecutionError } from "../../errors"
import { logError, logInfo, truncateForLog } from "../../shared/Logging"
import { ProcessRunner, type CommandExecutionResult, type ExecuteCommandInput } from "../Services/ProcessRunner"

const DEFAULT_TIMEOUT = Duration.seconds(30)
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

const timeoutFields = (timeout: Duration.Duration) => ({
  timeout: Duration.format(timeout),
  timeoutMs: Duration.toMillis(timeout),
})

const commandLogFields = (
  input: ExecuteCommandInput,
  timeout: Duration.Duration,
  maxOutputBytes: number,
): Record<string, unknown> => ({
  operation: input.operation,
  command: input.command,
  args: summarizeArgs(input.args),
  cwd: input.cwd ?? "",
  ...timeoutFields(timeout),
  maxOutputBytes,
  allowNonZeroExit: input.allowNonZeroExit ?? false,
  stdinBytes: input.stdin?.length ?? 0,
})

const commandResultLogFields = (
  input: ExecuteCommandInput,
  timeout: Duration.Duration,
  maxOutputBytes: number,
  result: CommandExecutionResult,
): Record<string, unknown> => ({
  ...commandLogFields(input, timeout, maxOutputBytes),
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

const collectOutput = Effect.fn("ProcessRunner.collectOutput")(function* (
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

const makeProcessRunner = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner

  const execute = Effect.fn("ProcessRunner.execute")(function* (input: ExecuteCommandInput) {
    const timeout = input.timeout ?? DEFAULT_TIMEOUT
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const encodedStdin =
      input.stdin === undefined ? "ignore" : Stream.fromIterable([new TextEncoder().encode(input.stdin)])

    yield* logInfo("Starting command.", commandLogFields(input, timeout, maxOutputBytes))

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
      Effect.timeoutOption(timeout),
      Effect.flatMap((maybeResult) =>
        Option.match(maybeResult, {
          onNone: () =>
            Effect.fail(
              toCommandExecutionError(input, `${commandLabel(input)} timed out after ${Duration.format(timeout)}.`),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.tap((result) =>
        logInfo("Command completed.", commandResultLogFields(input, timeout, maxOutputBytes, result)),
      ),
      Effect.tapError((error) =>
        logError("Command failed.", {
          ...commandLogFields(input, timeout, maxOutputBytes),
          detail: error.detail,
          exitCode: error.exitCode,
          stderrPreview: truncateForLog(error.stderr || error.detail),
        }),
      ),
      Effect.withLogSpan(input.operation),
    )
  })

  return {
    execute,
  }
})

export const ProcessRunnerLive = Layer.effect(ProcessRunner, makeProcessRunner)
