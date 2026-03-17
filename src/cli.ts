import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { Cause, Effect, Exit } from "effect"

import { getPullRequestMetadata, publishFailureSummary, publishReview } from "./azure-devops"
import { createAzureContext, ReviewConfigValue, type ReviewConfig } from "./config"
import { resolveGitDiff } from "./git"
import { parseJsonString, stringifyJson } from "./json"
import { logError, logInfo, withLogAnnotations } from "./logging"
import { runOpenCode } from "./opencode"
import { buildReviewContext } from "./review-context"
import { buildReviewPrompt } from "./review-prompt"
import { decodeReviewResult } from "./review-output"
import { buildSummaryComment } from "./thread-reconciliation"

const writeStdout = Effect.fn("cli.writeStdout")(function* (text: string) {
  const stdio = yield* Stdio.Stdio
  yield* Stream.make(text).pipe(Stream.run(stdio.stdout()))
})

const reviewLogFields = (config: ReviewConfig) => ({
  command: config.command,
  model: config.model,
  opencodeVariant: config.opencodeVariant,
  opencodeTimeoutMs: config.opencodeTimeoutMs,
  workspace: config.workspace,
  organization: config.organization,
  project: config.project,
  repositoryId: config.repositoryId,
  pullRequestId: config.pullRequestId,
  collectionUrl: config.collectionUrl,
  agent: config.agent,
  dryRun: config.dryRun,
  json: config.json,
})

const runReviewWithConfig = Effect.fn("cli.runReviewWithConfig")(function* (config: ReviewConfig) {
  return yield* Effect.gen(function* () {
    const azureContext = createAzureContext(config)

    yield* logInfo("Resolved review configuration.")
    yield* logInfo("Loading pull request metadata and git diff.")

    const [metadata, gitDiff] = yield* Effect.all([
      getPullRequestMetadata(azureContext, config.systemAccessToken),
      resolveGitDiff(config),
    ])

    yield* logInfo("Loaded review inputs.", {
      pullRequestTitle: metadata.title,
      changedFiles: gitDiff.changedFiles.length,
      diffBytes: gitDiff.diffText.length,
      baseRef: gitDiff.baseRef,
      headRef: gitDiff.headRef,
    })

    const reviewContext = yield* buildReviewContext(metadata, gitDiff)
    yield* logInfo("Built review context.", {
      changedFiles: reviewContext.changedFiles.length,
      manifestChars: stringifyJson(reviewContext).length,
    })
    const prompt = yield* buildReviewPrompt(config, reviewContext)
    yield* logInfo("Built review prompt.", {
      promptChars: prompt.length,
    })
    const rawResult = yield* runOpenCode(config, prompt)
    yield* logInfo("Received OpenCode response.", {
      responseChars: rawResult.length,
    })
    const decodedJson = yield* Effect.try({
      try: () => parseJsonString(rawResult),
      catch: () => ({ summary: rawResult, verdict: "concerns", findings: [], unmappedNotes: [] }),
    })
    const reviewResult = yield* decodeReviewResult(decodedJson, gitDiff.changedLinesByFile)
    yield* logInfo("Decoded review result.", {
      verdict: reviewResult.verdict,
      findings: reviewResult.findings.length,
      inlineFindings: reviewResult.inlineFindings.length,
      summaryOnlyFindings: reviewResult.summaryOnlyFindings.length,
      unmappedNotes: reviewResult.unmappedNotes.length,
    })
    const publishResult = yield* publishReview(config, reviewResult)
    yield* logInfo("Published review result.", {
      actions: publishResult.actions.length,
      dryRun: config.dryRun,
    })

    if (config.json) {
      yield* writeStdout(
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
      yield* writeStdout(`${buildSummaryComment(reviewResult)}\n`)
    } else {
      yield* writeStdout(
        `Posted review verdict ${reviewResult.verdict} with ${reviewResult.findings.length} findings.\n`,
      )
    }

    return 0
  }).pipe(withLogAnnotations(reviewLogFields(config)))
})

export const runCli = Effect.fn("cli.runCli")(function* () {
  const config = yield* ReviewConfigValue
  return yield* runReviewWithConfig(config).pipe(Effect.withLogSpan("open-azdo.review"))
})

export const runCliWithExitHandling = Effect.fn("cli.runCliWithExitHandling")(function* () {
  const exit = yield* Effect.exit(runCli())

  if (Exit.isSuccess(exit)) {
    return exit.value
  }

  const failureReason = Cause.pretty(exit.cause)
  const configExit = yield* Effect.exit(
    Effect.gen(function* () {
      return yield* ReviewConfigValue
    }),
  )

  if (Exit.isSuccess(configExit)) {
    yield* publishFailureSummary(configExit.value, failureReason).pipe(Effect.ignore)
  }

  yield* logError("open-azdo failed.", {
    cause: failureReason,
  })
  return 1
})
