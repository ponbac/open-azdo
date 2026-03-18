import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { Cause, Effect, Exit, type Redacted } from "effect"
import * as Duration from "effect/Duration"

import { type AzureContext, buildBuildLink, createAzureContext } from "@open-azdo/azdo/context"
import { AzureDevOpsClient } from "@open-azdo/azdo/client"
import { resolvePullRequestDiff } from "@open-azdo/core/git"
import { parseJsonUnknown, stringifyJson } from "@open-azdo/core/json"
import { logError, logInfo, withLogAnnotations } from "@open-azdo/core/logging"
import { OpenCodeRunner } from "@open-azdo/core/opencode"

import { publishFailureSummary, publishReview } from "./ReviewPublisher"
import { buildReviewContext } from "./ReviewContext"
import { decodeReviewResult } from "./ReviewOutput"
import { buildReviewPrompt } from "./ReviewPrompt"
import { buildSummaryComment } from "./ThreadReconciliation"

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
  readonly inheritedEnv: NodeJS.ProcessEnv
}

const writeStdout = Effect.fn("ReviewWorkflow.writeStdout")(function* (text: string) {
  const stdio = yield* Stdio.Stdio
  yield* Stream.make(text).pipe(Stream.run(stdio.stdout()))
})

const reviewLogFields = (config: ReviewWorkflowConfig) => ({
  command: "review",
  model: config.model,
  opencodeVariant: config.opencodeVariant,
  opencodeTimeout: Duration.format(config.opencodeTimeout),
  opencodeTimeoutMs: Duration.toMillis(config.opencodeTimeout),
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

const decodeOpenCodeResult = (rawResult: string) =>
  parseJsonUnknown(rawResult).pipe(
    Effect.match({
      onFailure: () => ({
        summary: rawResult,
        verdict: "concerns",
        findings: [],
        unmappedNotes: [],
      }),
      onSuccess: (decodedJson) => decodedJson,
    }),
  )

const writeReviewWorkflowOutput = (
  config: ReviewWorkflowConfig,
  findingsCount: number,
  inlineFindingsCount: number,
  unmappedNotesCount: number,
  verdict: string,
  buildSummary: string,
  actionCount: number,
) => {
  if (config.json) {
    return writeStdout(
      `${stringifyJson({
        status: "ok",
        verdict,
        findings: findingsCount,
        inlineFindings: inlineFindingsCount,
        unmappedNotes: unmappedNotesCount,
        dryRun: config.dryRun,
        actions: actionCount,
      })}\n`,
    )
  }

  if (config.dryRun) {
    return writeStdout(`${buildSummary}\n`)
  }

  return writeStdout(`Posted review verdict ${verdict} with ${findingsCount} findings.\n`)
}

const runReviewWithResolvedConfig = (
  config: ReviewWorkflowConfig,
  azureContext: AzureContext,
  buildLink: string | undefined,
) =>
  Effect.gen(function* () {
    const azureClient = yield* AzureDevOpsClient
    const openCodeRunner = yield* OpenCodeRunner

    yield* logInfo("Resolved review configuration.")
    yield* logInfo("Loading pull request metadata and git diff.")

    const [metadata, gitDiff] = yield* Effect.all(
      [
        azureClient.getPullRequestMetadata({
          context: azureContext,
          token: config.systemAccessToken,
        }),
        resolvePullRequestDiff({
          workspace: config.workspace,
          targetBranch: config.targetBranch,
        }),
      ],
      { concurrency: "unbounded" },
    )

    yield* logInfo("Loaded review inputs.", {
      pullRequestTitle: metadata.title,
      changedFiles: gitDiff.changedFiles.length,
      diffBytes: gitDiff.diffText.length,
      baseRef: gitDiff.baseRef,
      headRef: gitDiff.headRef,
    })

    const reviewContext = buildReviewContext(metadata, gitDiff)
    yield* logInfo("Built review context.", {
      changedFiles: reviewContext.changedFiles.length,
      manifestChars: stringifyJson(reviewContext).length,
    })

    const prompt = yield* buildReviewPrompt(config.promptFile, reviewContext)
    yield* logInfo("Built review prompt.", {
      promptChars: prompt.length,
    })

    const rawResult = yield* openCodeRunner.run({
      workspace: config.workspace,
      model: config.model,
      agent: config.agent,
      variant: config.opencodeVariant,
      timeout: config.opencodeTimeout,
      prompt,
      inheritedEnv: config.inheritedEnv,
    })
    yield* logInfo("Received OpenCode response.", {
      responseChars: rawResult.length,
    })

    const reviewResult = yield* decodeOpenCodeResult(rawResult).pipe(
      Effect.flatMap((decodedJson) => decodeReviewResult(decodedJson, gitDiff.changedLinesByFile)),
    )
    yield* logInfo("Decoded review result.", {
      verdict: reviewResult.verdict,
      findings: reviewResult.findings.length,
      inlineFindings: reviewResult.inlineFindings.length,
      summaryOnlyFindings: reviewResult.summaryOnlyFindings.length,
      unmappedNotes: reviewResult.unmappedNotes.length,
    })

    const publishResult = yield* publishReview({
      context: azureContext,
      token: config.systemAccessToken,
      dryRun: config.dryRun,
      buildLink,
      reviewResult,
    })
    yield* logInfo("Published review result.", {
      actions: publishResult.actions.length,
      dryRun: config.dryRun,
    })

    yield* writeReviewWorkflowOutput(
      config,
      reviewResult.findings.length,
      reviewResult.inlineFindings.length,
      reviewResult.unmappedNotes.length,
      reviewResult.verdict,
      buildSummaryComment(reviewResult, buildLink),
      publishResult.actions.length,
    )

    return 0
  }).pipe(withLogAnnotations(reviewLogFields(config)), Effect.withLogSpan("open-azdo.review"))

export const runReviewWorkflow = (config: ReviewWorkflowConfig) =>
  Effect.gen(function* () {
    const azureContext = createAzureContext(config)
    const buildLink = buildBuildLink(config)
    const exit = yield* Effect.exit(runReviewWithResolvedConfig(config, azureContext, buildLink))

    if (Exit.isSuccess(exit)) {
      return exit.value
    }

    const failureReason = Cause.pretty(exit.cause)
    yield* publishFailureSummary({
      context: azureContext,
      token: config.systemAccessToken,
      dryRun: config.dryRun,
      buildLink,
      failureReason,
    }).pipe(Effect.ignore)

    yield* logError("open-azdo failed.", {
      cause: failureReason,
    })

    return 1
  })
