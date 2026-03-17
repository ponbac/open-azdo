import { Cause, Effect } from "effect"

import { getPullRequestMetadata, publishFailureSummary, publishReview } from "./azure-devops"
import { createAzureContext, loadReviewConfig, type ReviewConfig } from "./config"
import { resolveGitDiff } from "./git"
import { parseJsonString, stringifyJson } from "./json"
import { writeErrorLog, writeInfoLog } from "./logging"
import { runOpenCode } from "./opencode"
import { buildReviewContext } from "./review-context"
import { buildReviewPrompt } from "./review-prompt"
import { decodeReviewResult } from "./review-output"
import { buildSummaryComment } from "./thread-reconciliation"

export const runCli = Effect.fn("cli.runCli")(function* (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv) {
  const config = yield* loadReviewConfig(argv, env)
  return yield* runReviewWithConfig(config)
})

const runReviewWithConfig = Effect.fn("cli.runReviewWithConfig")(function* (config: ReviewConfig) {
  const azureContext = createAzureContext(config)

  writeInfoLog("Resolved review configuration.", {
    command: config.command,
    model: config.model,
    workspace: config.workspace,
    organization: config.organization,
    project: config.project,
    repositoryId: config.repositoryId,
    pullRequestId: config.pullRequestId,
    collectionUrl: config.collectionUrl,
    agent: config.agent,
    dryRun: config.dryRun,
    json: config.json,
    systemAccessToken: config.systemAccessToken,
  })

  const [metadata, gitDiff] = yield* Effect.all([
    getPullRequestMetadata(azureContext, config.systemAccessToken),
    resolveGitDiff(config),
  ])

  const reviewContext = yield* buildReviewContext(config.workspace, metadata, gitDiff)
  const prompt = yield* buildReviewPrompt(config, reviewContext)
  const rawResult = yield* runOpenCode(config, prompt)
  const decodedJson = yield* Effect.try({
    try: () => parseJsonString(rawResult),
    catch: () => ({ summary: rawResult, verdict: "concerns", findings: [], unmappedNotes: [] }),
  })
  const reviewResult = yield* decodeReviewResult(decodedJson, gitDiff.changedLinesByFile)
  const publishResult = yield* publishReview(config, reviewResult)

  if (config.json) {
    process.stdout.write(
      `${stringifyJson({
        status: "ok",
        verdict: reviewResult.verdict,
        findings: reviewResult.findings.length,
        inlineFindings: reviewResult.inlineFindings.length,
        unmappedNotes: reviewResult.unmappedNotes.length,
        dryRun: config.dryRun,
        actions: publishResult.actions.length,
      })}\n`,
    )
  } else if (config.dryRun) {
    process.stdout.write(`${buildSummaryComment(reviewResult)}\n`)
  } else {
    process.stdout.write(
      `Posted review verdict ${reviewResult.verdict} with ${reviewResult.findings.length} findings.\n`,
    )
  }

  return 0
})

export const runCliWithExitHandling = async (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => {
  const exit = await Effect.runPromiseExit(runCli(argv, env))

  if (exit._tag === "Success") {
    return exit.value
  }

  const failureReason = Cause.pretty(exit.cause)
  const configExit = await Effect.runPromiseExit(loadReviewConfig(argv, env))

  if (configExit._tag === "Success") {
    await Effect.runPromise(publishFailureSummary(configExit.value, failureReason).pipe(Effect.ignore))
  }

  writeErrorLog("open-azdo failed.", {
    cause: failureReason,
  })
  return 1
}
