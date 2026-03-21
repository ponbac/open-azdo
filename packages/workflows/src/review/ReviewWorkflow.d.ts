import * as Stdio from "effect/Stdio"
import { Effect, type Redacted } from "effect"
import * as Duration from "effect/Duration"
import { type AzureContext } from "@open-azdo/azdo/context"
import { AzureDevOpsClient } from "@open-azdo/azdo/client"
import { OpenCodeRunner } from "@open-azdo/core/opencode"
export type ReviewWorkflowConfig = AzureContext & {
  readonly model: string
  readonly opencodeVariant?: string
  readonly opencodeTimeout: Duration.Duration
  readonly workspace: string
  readonly agent: string
  readonly promptFile?: string
  readonly dryRun: boolean
  readonly json: boolean
  readonly systemAccessToken: Redacted.Redacted<string>
  readonly sourceCommitId?: string
  readonly inheritedEnv: NodeJS.ProcessEnv
}
export declare const runReviewWorkflow: (
  config: ReviewWorkflowConfig,
) => Effect.Effect<
  number,
  never,
  | AzureDevOpsClient
  | import("effect/FileSystem").FileSystem
  | import("@open-azdo/core/git").GitExec
  | OpenCodeRunner
  | Stdio.Stdio
>
