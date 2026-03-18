import { ServiceMap } from "effect"
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

export interface GitExecShape {
  readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>
}

export class GitExec extends ServiceMap.Service<GitExec, GitExecShape>()("open-azdo/git/GitExec") {}
