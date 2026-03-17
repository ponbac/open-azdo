import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { Cause, Effect, Exit } from "effect"
import * as Duration from "effect/Duration"

import { publishFailureSummary, publishReview } from "../azdo/ReviewPublisher"
import { AzureDevOpsClient } from "../azdo/Services/AzureDevOpsClient"
import { AppConfig, buildBuildLink, createAzureContext } from "../config/AppConfig"
import { resolvePullRequestDiff } from "../git/PullRequestDiff"
import { OpenCodeRunner } from "../opencode/Services/OpenCodeRunner"
import { parseJsonUnknown, stringifyJson } from "../shared/Json"
import { logError, logInfo, withLogAnnotations } from "../shared/Logging"
import { buildReviewContext } from "./ReviewContext"
import { buildReviewPrompt } from "./ReviewPrompt"
import { buildSummaryComment } from "./ThreadReconciliation"
import { decodeReviewResult } from "./ReviewOutput"

const writeStdout = Effect.fn("Workflow.writeStdout")(function* (text: string) {
  const stdio = yield* Stdio.Stdio
  yield* Stream.make(text).pipe(Stream.run(stdio.stdout()))
})

const reviewLogFields = (config: AppConfig["Service"]) => ({
  command: config.command,
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

type ResolvedWorkflowInput = {
  readonly config: AppConfig["Service"]
  readonly azureContext: ReturnType<typeof createAzureContext>
  readonly buildLink: ReturnType<typeof buildBuildLink>
}

const runReviewWithResolvedConfig = ({ config, azureContext, buildLink }: ResolvedWorkflowInput) =>
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
      inheritedEnv: process.env,
    })
    yield* logInfo("Received OpenCode response.", {
      responseChars: rawResult.length,
    })

    const decodedJson = yield* parseJsonUnknown(rawResult).pipe(
      Effect.catch(() =>
        Effect.succeed({
          summary: rawResult,
          verdict: "concerns",
          findings: [],
          unmappedNotes: [],
        }),
      ),
    )

    const reviewResult = yield* decodeReviewResult(decodedJson, gitDiff.changedLinesByFile)
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
  }).pipe(withLogAnnotations(reviewLogFields(config)), Effect.withLogSpan("open-azdo.review"))

export const runReviewWorkflow = Effect.gen(function* () {
  const config = yield* AppConfig
  const azureContext = createAzureContext(config)
  const buildLink = buildBuildLink(config)
  const exit = yield* Effect.exit(
    runReviewWithResolvedConfig({
      config,
      azureContext,
      buildLink,
    }),
  )

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
