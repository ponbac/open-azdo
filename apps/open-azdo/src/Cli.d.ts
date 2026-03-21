import * as Command from "effect/unstable/cli/Command"
import { Effect } from "effect"
import { AppConfig, type ReviewCliInput } from "./AppConfig"
import { OperationalError } from "./errors"
export declare const executeReview: Effect.Effect<
  number,
  never,
  | AppConfig
  | import("@open-azdo/azdo/client").AzureDevOpsClient
  | import("effect/FileSystem").FileSystem
  | import("@open-azdo/core/git").GitExec
  | import("@open-azdo/core/opencode").OpenCodeRunner
  | import("effect/Stdio").Stdio
>
export declare const executeReviewWithInput: (
  input: ReviewCliInput,
) => Effect.Effect<number, import("effect/Config").ConfigError | import("./errors").ConfigError, never>
export declare const reviewCommand: Command.Command<
  "review",
  {
    readonly model: import("effect/Option").Option<string>
    readonly opencodeVariant: import("effect/Option").Option<string>
    readonly opencodeTimeout: import("effect/Option").Option<string>
    readonly workspace: import("effect/Option").Option<string>
    readonly organization: import("effect/Option").Option<string>
    readonly project: import("effect/Option").Option<string>
    readonly repositoryId: import("effect/Option").Option<string>
    readonly pullRequestId: import("effect/Option").Option<number>
    readonly collectionUrl: import("effect/Option").Option<string>
    readonly agent: import("effect/Option").Option<string>
    readonly promptFile: import("effect/Option").Option<string>
    readonly dryRun: boolean
    readonly json: boolean
  },
  {},
  OperationalError,
  never
>
export declare const openAzdoCli: Command.Command<"open-azdo", {}, {}, OperationalError, never>
