import { Effect, Layer } from "effect"

import { GitCommandError } from "../../errors"
import { ProcessRunner } from "../../process-runner"
import { GitExec, type ExecuteGitInput, type ExecuteGitResult } from "../Services/GitExec"

const quoteGitCommand = (args: ReadonlyArray<string>) => `git ${args.join(" ")}`

const createGitCommandError = (input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">, detail: string) =>
  new GitCommandError({
    operation: input.operation,
    command: quoteGitCommand(input.args),
    cwd: input.cwd,
    detail,
  })

const makeGitExec = Effect.gen(function* () {
  const runner = yield* ProcessRunner

  const execute: GitExec["Service"]["execute"] = Effect.fn("GitExec.execute")(function* (input) {
    const result = yield* runner
      .execute({
        operation: input.operation,
        command: "git",
        args: input.args,
        cwd: input.cwd,
        ...(input.env ? { env: input.env } : {}),
        allowNonZeroExit: true,
        ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      })
      .pipe(
        Effect.mapError((error) =>
          createGitCommandError(input, error.stderr.trim().length > 0 ? error.stderr.trim() : error.detail),
        ),
      )

    if (!input.allowNonZeroExit && result.exitCode !== 0) {
      return yield* createGitCommandError(
        input,
        result.stderr.trim().length > 0
          ? `${quoteGitCommand(input.args)} failed: ${result.stderr.trim()}`
          : `${quoteGitCommand(input.args)} failed with code ${result.exitCode}.`,
      )
    }

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    } satisfies ExecuteGitResult
  })

  return {
    execute,
  }
})

export const GitExecLive = Layer.effect(GitExec, makeGitExec)
