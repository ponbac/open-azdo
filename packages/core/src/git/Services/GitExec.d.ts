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
declare const GitExec_base: ServiceMap.ServiceClass<GitExec, "open-azdo/git/GitExec", GitExecShape>
export declare class GitExec extends GitExec_base {}
export {}
