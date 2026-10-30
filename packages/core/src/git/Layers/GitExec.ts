import { Effect, Layer } from "effect"

import { GitCommandError } from "../../errors"
import { ProcessRunner, type ExecuteCommandInput } from "../../process-runner"
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
    let commandInput: ExecuteCommandInput = {
      operation: input.operation,
      command: "git",
      args: input.args,
      cwd: input.cwd,
      allowNonZeroExit: true,
    }

    if (input.env) {
      commandInput = { ...commandInput, env: input.env }
    }

    if (input.timeout !== undefined) {
      commandInput = { ...commandInput, timeout: input.timeout }
    }

    if (input.maxOutputBytes !== undefined) {
      commandInput = { ...commandInput, maxOutputBytes: input.maxOutputBytes }
    }

    const result = yield* runner
      .execute(commandInput)
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

  return GitExec.of({
    execute,
  })
})

export const GitExecLive = Layer.effect(GitExec, makeGitExec)
