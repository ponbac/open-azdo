import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { Cause, Effect, Exit, type Redacted } from "effect"
import * as Duration from "effect/Duration"

import { type AzureContext, buildBuildLink, createAzureContext } from "@open-azdo/azdo/context"
import { AzureDevOpsClient } from "@open-azdo/azdo/client"
import {
  isAncestor,
  resolveDiffRange,
  resolvePullRequestDiff,
  resolveReviewedSourceCommit,
  type PullRequestDiff,
} from "@open-azdo/core/git"
import { parseJsonUnknown, stringifyJson } from "@open-azdo/core/json"
import { logError, logInfo, withLogAnnotations } from "@open-azdo/core/logging"
import { OpenCodeRunner } from "@open-azdo/core/opencode"

import { publishFailureSummary, publishReview } from "./ReviewPublisher"
import { buildReviewContext, type ReviewMode } from "./ReviewContext"
import { decodeReviewResult } from "./ReviewOutput"
import { buildReviewPrompt } from "./ReviewPrompt"
import {
  buildManagedReviewState,
  buildSummaryComment,
  findManagedSummaryThread,
  type ManagedReviewState,
  mergeFollowUpReviewResult,
} from "./ThreadReconciliation"

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

type ReviewWorkflowOutput = {
  readonly findingsCount: number
  readonly inlineFindingsCount: number
  readonly unmappedNotesCount: number
  readonly verdict: string
  readonly buildSummary: string
  readonly actionCount: number
  readonly reviewMode: ReviewMode
  readonly skipped: boolean
}

type ResolvedReviewScope = {
  readonly reviewMode: ReviewMode
  readonly scopedDiff: PullRequestDiff
  readonly previousReviewedCommit: string | undefined
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

const resolveReviewScope = ({
  config,
  fullPullRequestDiff,
  reviewedSourceCommit,
  previousSummaryState,
}: {
  readonly config: ReviewWorkflowConfig
  readonly fullPullRequestDiff: PullRequestDiff
  readonly reviewedSourceCommit: string
  readonly previousSummaryState: ManagedReviewState | undefined
}) =>
  Effect.gen(function* () {
    const previousReviewedCommit = previousSummaryState?.reviewedCommit
    const previousPullRequestBaseRef = previousSummaryState?.pullRequestBaseRef

    if (!previousReviewedCommit) {
      return {
        reviewMode: "full",
        scopedDiff: fullPullRequestDiff,
        previousReviewedCommit,
      } satisfies ResolvedReviewScope
    }

    if (previousReviewedCommit === reviewedSourceCommit) {
      if (previousPullRequestBaseRef === fullPullRequestDiff.baseRef) {
        return {
          reviewMode: "skipped",
          scopedDiff: fullPullRequestDiff,
          previousReviewedCommit,
        } satisfies ResolvedReviewScope
      }

      yield* logInfo("Previous managed review used a different pull-request base. Falling back to a full review.", {
        previousReviewedCommit,
        reviewedSourceCommit,
        previousPullRequestBaseRef,
        currentPullRequestBaseRef: fullPullRequestDiff.baseRef,
      })

      return {
        reviewMode: "full",
        scopedDiff: fullPullRequestDiff,
        previousReviewedCommit,
      } satisfies ResolvedReviewScope
    }

    const previousCommitIsAncestor = yield* isAncestor({
      workspace: config.workspace,
      ancestorRef: previousReviewedCommit,
      headRef: reviewedSourceCommit,
    }).pipe(Effect.orElseSucceed(() => undefined))

    if (previousCommitIsAncestor === true) {
      return {
        reviewMode: "follow-up",
        scopedDiff: yield* resolveDiffRange({
          workspace: config.workspace,
          baseRef: previousReviewedCommit,
          headRef: reviewedSourceCommit,
        }),
        previousReviewedCommit,
      } satisfies ResolvedReviewScope
    }

    if (previousCommitIsAncestor === false) {
      yield* logInfo(
        "Previous managed review commit is not an ancestor of the current source commit. Falling back to a full review.",
        {
          previousReviewedCommit,
          reviewedSourceCommit,
        },
      )
    } else {
      yield* logInfo("Previous managed review commit could not be validated locally. Falling back to a full review.", {
        previousReviewedCommit,
        reviewedSourceCommit,
      })
    }

    return {
      reviewMode: "full",
      scopedDiff: fullPullRequestDiff,
      previousReviewedCommit,
    } satisfies ResolvedReviewScope
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

const writeReviewWorkflowOutput = (config: ReviewWorkflowConfig, output: ReviewWorkflowOutput) => {
  if (config.json) {
    return writeStdout(
      `${stringifyJson({
        status: "ok",
        verdict: output.verdict,
        findings: output.findingsCount,
        inlineFindings: output.inlineFindingsCount,
        unmappedNotes: output.unmappedNotesCount,
        dryRun: config.dryRun,
        actions: output.actionCount,
        skipped: output.skipped,
        reviewMode: output.reviewMode,
      })}\n`,
    )
  }

  if (config.dryRun) {
    return writeStdout(`${output.buildSummary}\n`)
  }

  if (output.skipped) {
    return writeStdout("Skipped review: no new commits since the last managed review.\n")
  }

  return writeStdout(`Posted review verdict ${output.verdict} with ${output.findingsCount} findings.\n`)
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
    yield* logInfo("Loading pull request metadata, git diff, source commit, and existing threads.")

    const [metadata, fullPullRequestDiff, reviewedSourceCommit, existingThreads] = yield* Effect.all(
      [
        azureClient.getPullRequestMetadata({
          context: azureContext,
          token: config.systemAccessToken,
        }),
        resolvePullRequestDiff({
          workspace: config.workspace,
          targetBranch: config.targetBranch,
        }),
        resolveReviewedSourceCommit({
          workspace: config.workspace,
          sourceCommitId: config.sourceCommitId,
        }),
        azureClient.listThreads({
          context: azureContext,
          token: config.systemAccessToken,
        }),
      ],
      { concurrency: "unbounded" },
    )

    yield* logInfo("Loaded review inputs.", {
      pullRequestTitle: metadata.title,
      changedFiles: fullPullRequestDiff.changedFiles.length,
      diffBytes: fullPullRequestDiff.diffText.length,
      baseRef: fullPullRequestDiff.baseRef,
      headRef: fullPullRequestDiff.headRef,
      existingThreads: existingThreads.length,
      reviewedSourceCommit,
    })

    const previousSummaryState = findManagedSummaryThread(existingThreads)?.reviewState
    const { reviewMode, scopedDiff, previousReviewedCommit } = yield* resolveReviewScope({
      config,
      fullPullRequestDiff,
      reviewedSourceCommit,
      previousSummaryState,
    })

    if (reviewMode === "skipped" && previousSummaryState) {
      const summaryContent = buildSummaryComment({
        verdict: previousSummaryState.verdict,
        summary: "⏭️ No new commits since the last managed review. Previous verdict still applies.",
        unmappedNotes: [],
        severityCounts: previousSummaryState.severityCounts,
        buildLink,
        persistedState: previousSummaryState,
      })
      const publishResult = yield* publishReview({
        context: azureContext,
        token: config.systemAccessToken,
        dryRun: config.dryRun,
        summaryContent,
        inlineFindings: [],
        reviewMode,
        scopedChangedLinesByFile: scopedDiff.changedLinesByFile,
        scopedDeletedLinesByFile: scopedDiff.deletedLinesByFile,
      })

      yield* logInfo("Skipped review because no new commits were added since the last managed review.", {
        reviewedSourceCommit,
        actions: publishResult.actions.length,
      })

      yield* writeReviewWorkflowOutput(config, {
        findingsCount: previousSummaryState.findingsCount,
        inlineFindingsCount: previousSummaryState.inlineFindingsCount,
        unmappedNotesCount: previousSummaryState.unmappedNotesCount,
        verdict: previousSummaryState.verdict,
        buildSummary: publishResult.summaryContent,
        actionCount: publishResult.actions.length,
        reviewMode,
        skipped: true,
      })

      return 0
    }

    const reviewContext = buildReviewContext({
      metadata,
      reviewMode,
      previousReviewedCommit,
      pullRequestBaseRef: fullPullRequestDiff.baseRef,
      gitDiff: scopedDiff,
    })
    yield* logInfo("Built review context.", {
      reviewMode,
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
      Effect.flatMap((decodedJson) => decodeReviewResult(decodedJson, scopedDiff.changedLinesByFile)),
    )
    yield* logInfo("Decoded review result.", {
      reviewMode,
      verdict: reviewResult.verdict,
      findings: reviewResult.findings.length,
      inlineFindings: reviewResult.inlineFindings.length,
      summaryOnlyFindings: reviewResult.summaryOnlyFindings.length,
      unmappedNotes: reviewResult.unmappedNotes.length,
    })

    const outstandingReviewResult =
      reviewMode === "follow-up"
        ? mergeFollowUpReviewResult({
            existingThreads,
            scopedChangedLinesByFile: scopedDiff.changedLinesByFile,
            scopedDeletedLinesByFile: scopedDiff.deletedLinesByFile,
            reviewResult,
          })
        : reviewResult

    const summaryState = buildManagedReviewState({
      reviewedCommit: reviewedSourceCommit,
      pullRequestBaseRef: fullPullRequestDiff.baseRef,
      reviewResult: outstandingReviewResult,
    })
    const summaryContent = buildSummaryComment({
      verdict: summaryState.verdict,
      summary: outstandingReviewResult.summary,
      unmappedNotes: outstandingReviewResult.unmappedNotes,
      severityCounts: summaryState.severityCounts,
      buildLink,
      persistedState: summaryState,
    })

    const publishResult = yield* publishReview({
      context: azureContext,
      token: config.systemAccessToken,
      dryRun: config.dryRun,
      summaryContent,
      inlineFindings: reviewResult.inlineFindings,
      reviewMode,
      scopedChangedLinesByFile: scopedDiff.changedLinesByFile,
      scopedDeletedLinesByFile: scopedDiff.deletedLinesByFile,
    })
    yield* logInfo("Published review result.", {
      actions: publishResult.actions.length,
      dryRun: config.dryRun,
      reviewMode,
    })

    yield* writeReviewWorkflowOutput(config, {
      findingsCount: summaryState.findingsCount,
      inlineFindingsCount: summaryState.inlineFindingsCount,
      unmappedNotesCount: summaryState.unmappedNotesCount,
      verdict: summaryState.verdict,
      buildSummary: publishResult.summaryContent,
      actionCount: publishResult.actions.length,
      reviewMode,
      skipped: false,
    })

    return 0
  }).pipe(withLogAnnotations(reviewLogFields(config)), Effect.withLogSpan("open-azdo.review"))

export const runReviewWorkflow = (config: ReviewWorkflowConfig) =>
  Effect.gen(function* () {
    const azureContext = createAzureContext(config)
    const buildLink = buildBuildLink(config)
    const azureClient = yield* AzureDevOpsClient
    const exit = yield* Effect.exit(runReviewWithResolvedConfig(config, azureContext, buildLink))

    if (Exit.isSuccess(exit)) {
      return exit.value
    }

    const failureReason = Cause.pretty(exit.cause)
    const existingThreads = yield* azureClient
      .listThreads({
        context: azureContext,
        token: config.systemAccessToken,
      })
      .pipe(
        Effect.match({
          onFailure: () => [],
          onSuccess: (threads) => threads,
        }),
      )

    yield* publishFailureSummary({
      context: azureContext,
      token: config.systemAccessToken,
      dryRun: config.dryRun,
      buildLink,
      existingThreads,
      failureReason,
      preservedSummaryState: findManagedSummaryThread(existingThreads)?.reviewState,
    }).pipe(Effect.ignore)

    yield* logError("open-azdo failed.", {
      cause: failureReason,
    })

    return 1
  })
