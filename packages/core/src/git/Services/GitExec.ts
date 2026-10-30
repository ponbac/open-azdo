import { Context } from "effect"
import type { Duration } from "effect/Duration"
import type { Effect } from "effect"

import type { GitCommandError } from "../../errors"

export type ExecuteGitInput = {
  readonly operation: string
  readonly cwd: string
  readonly args: ReadonlyArray<string>
  readonly env?: NodeJS.ProcessEnv
  readonly allowNonZeroExit?: boolean
  readonly timeout?: Duration
  readonly maxOutputBytes?: number
}

export type ExecuteGitResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Executes Git argv commands and translates command failures into Git-specific errors. */
export class GitExec extends Context.Service<
  GitExec,
  {
    readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>
  }
>()("open-azdo/git/GitExec") {}
