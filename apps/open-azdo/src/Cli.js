import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { Cause, Effect, Exit, Schema } from "effect"
import { BaseRuntimeLayer } from "@open-azdo/core/base-runtime"
import { logError } from "@open-azdo/core/logging"
import { runReviewWorkflow } from "@open-azdo/workflows/review"
import { AppConfig } from "./AppConfig"
import { OperationalError } from "./errors"
import { makeRuntimeLayer } from "./Runtime"
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0))
export const executeReview = Effect.gen(function* () {
  const config = yield* AppConfig
  return yield* runReviewWorkflow({
    ...config,
    inheritedEnv: process.env,
  })
})
export const executeReviewWithInput = (input) => executeReview.pipe(Effect.provide(makeRuntimeLayer(input)))
const runReviewCommand = (input) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(executeReviewWithInput(input))
    if (!Exit.isSuccess(exit)) {
      const failureReason = Cause.pretty(exit.cause)
      yield* logError("open-azdo failed during startup.", {
        cause: failureReason,
      }).pipe(Effect.provide(BaseRuntimeLayer))
      return yield* new OperationalError({
        message: "open-azdo failed during startup.",
      })
    }
    if (exit.value === 0) {
      return
    }
    return yield* new OperationalError({
      message: "open-azdo exited with a non-zero status.",
    })
  })
const reviewCommandConfig = {
  model: Flag.string("model").pipe(Flag.optional, Flag.withDescription("Model id, for example openai/gpt-5.4.")),
  opencodeVariant: Flag.string("opencode-variant").pipe(
    Flag.optional,
    Flag.withDescription("Provider-specific variant or reasoning level."),
  ),
  opencodeTimeout: Flag.string("opencode-timeout").pipe(
    Flag.optional,
    Flag.withDescription('OpenCode timeout, for example "5 minutes" or "1 hour".'),
  ),
  workspace: Flag.string("workspace").pipe(Flag.optional, Flag.withDescription("Workspace path.")),
  organization: Flag.string("organization").pipe(Flag.optional, Flag.withDescription("Azure DevOps organization.")),
  project: Flag.string("project").pipe(Flag.optional, Flag.withDescription("Azure DevOps project.")),
  repositoryId: Flag.string("repository-id").pipe(Flag.optional, Flag.withDescription("Azure DevOps repository id.")),
  pullRequestId: Flag.integer("pull-request-id").pipe(
    Flag.withSchema(PositiveIntSchema),
    Flag.optional,
    Flag.withDescription("Azure DevOps pull request id."),
  ),
  collectionUrl: Flag.string("collection-url").pipe(
    Flag.optional,
    Flag.withDescription("Azure DevOps collection url."),
  ),
  agent: Flag.string("agent").pipe(Flag.optional, Flag.withDescription("OpenCode agent name.")),
  promptFile: Flag.string("prompt-file").pipe(
    Flag.optional,
    Flag.withDescription("Path to an additional prompt file."),
  ),
  dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("Do not publish comments.")),
  json: Flag.boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Emit machine-readable JSON.")),
}
export const reviewCommand = Command.make("review", reviewCommandConfig).pipe(
  Command.withDescription("Review an Azure DevOps pull request with OpenCode."),
  Command.withHandler((input) => runReviewCommand(input)),
)
export const openAzdoCli = Command.make("open-azdo").pipe(
  Command.withDescription("Secure Azure DevOps pull-request review CLI powered by OpenCode."),
  Command.withSubcommands([reviewCommand]),
)
