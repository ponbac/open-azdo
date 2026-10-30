import { Context } from "effect"
import type { Duration } from "effect/Duration"
import type { Effect } from "effect"

import type { CommandExecutionError } from "../../errors"

export type CommandExecutionResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type ExecuteCommandInput = {
  readonly operation: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: string
  readonly timeout?: Duration
  readonly maxOutputBytes?: number
  readonly allowNonZeroExit?: boolean
}

/** Executes bounded child processes and reports expected launch, exit, and output failures. */
export class ProcessRunner extends Context.Service<
  ProcessRunner,
  {
    readonly execute: (input: ExecuteCommandInput) => Effect.Effect<CommandExecutionResult, CommandExecutionError>
  }
>()("open-azdo/platform/ProcessRunner") {}
