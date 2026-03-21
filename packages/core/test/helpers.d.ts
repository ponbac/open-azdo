import { Effect, Layer } from "effect"
import { GitExec, type GitExecShape, type PullRequestDiff } from "@open-azdo/core/git"
import { type OpenCodeRunRequest } from "@open-azdo/core/opencode"
import { ProcessRunner, type CommandExecutionResult, type ExecuteCommandInput } from "@open-azdo/core/process-runner"
export declare const createTempDir: (prefix: string) => Promise<string>
export declare const createFixtureRepo: () => Promise<{
  featureSha: string
  mainSha: string
  repoDir: string
}>
export declare const createSyntheticMergeRepo: () => Promise<{
  featureSha: string
  mainSha: string
  mergeSha: string
  repoDir: string
}>
export declare const createDeletionFollowUpRepo: () => Promise<{
  repoDir: string
  reviewedSha: string
  headSha: string
}>
export declare const createDeletedFileFollowUpRepo: () => Promise<{
  repoDir: string
  reviewedSha: string
  headSha: string
}>
export declare const withSilentLogs: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, never>>
export declare const makeProcessRunner: (
  execute: (input: ExecuteCommandInput) => Effect.Effect<CommandExecutionResult, never>,
) => ProcessRunner["Service"]
export declare const makeGitExec: (execute: GitExecShape["execute"]) => GitExec["Service"]
export declare const makeGitExecLayer: (service: GitExec["Service"]) => Layer.Layer<GitExec, never, never>
export declare const makeRealGitExecLayer: () => Layer.Layer<GitExec, never, never>
export declare const makeOpenCodeLiveLayer: (
  runner: ProcessRunner["Service"],
) => Layer.Layer<import("@open-azdo/core/opencode").OpenCodeRunner, never, never>
export declare const makeOpenCodeRunRequest: (overrides?: Partial<OpenCodeRunRequest>) => OpenCodeRunRequest
export declare const makePullRequestDiff: (overrides?: Partial<PullRequestDiff>) => PullRequestDiff
