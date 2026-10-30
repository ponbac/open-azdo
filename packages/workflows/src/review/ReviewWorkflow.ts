import { jsonrepair } from "jsonrepair"

import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { Cause, Effect, Exit, Option, Schema, type Redacted } from "effect"
import type * as Duration from "effect/Duration"

import { type AzureContext, buildBuildLink, createAzureContext } from "@open-azdo/azdo/context"
import { AzureDevOpsClient, type PullRequestMetadata, type PullRequestWorkItem } from "@open-azdo/azdo/client"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import {
  hasTargetMergeCommitInRange,
  isAncestor,
  resolveDiffRange,
  resolvePullRequestDiff,
  resolveReviewedSourceCommit,
  type PullRequestDiff,
} from "@open-azdo/core/git"
import { logError, logInfo } from "@open-azdo/core/logging"
import { OpenCodeOutputError } from "@open-azdo/core/errors"
import { OpenCodeRunner, type OpenCodeRunResult, type OpenCodeRunUsage } from "@open-azdo/core/opencode"

import { publishFailureSummary, publishReview } from "./ReviewPublisher"
import { buildReviewContext, type ReviewMode } from "./ReviewContext"
import {
  decodeReviewResult,
  type NormalizedReviewResult,
  type ReviewFinding,
  ReviewResultJsonSchema,
} from "./ReviewOutput"
import { buildReviewPrompt } from "./ReviewPrompt"
import {
  buildReviewSummarySubjects,
  decodeReviewSummaryPassOutput,
  renderReviewSummaryFallback,
  renderReviewSummaryFromHighlights,
  ReviewSummaryPassOutputJsonSchema,
  type ReviewSummaryPassOutput,
  type ReviewSummarySubject,
  validateReviewSummaryPassOutput,
} from "./ReviewSummary"
import { buildReviewSummaryPrompt } from "./ReviewSummaryPrompt"
import {
  buildManagedReviewState,
  buildSummaryComment,
  decodeManagedThreads,
  mergeManagedReviewResult,
  reconcileThreads,
  type ManagedReviewState,
  type ReviewHistoryEntry,
  type ReviewHistoryTokens,
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
  readonly forceFullReview?: boolean
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
  readonly scopedDiff: PullRequestDiff
  readonly previousReviewedCommit: string | undefined
} & (
  | { readonly reviewMode: "full" | "follow-up" }
  | { readonly reviewMode: "skipped"; readonly previousSummaryState: ManagedReviewState }
)

export type ReviewResultSource = "structured" | "repaired" | "fallback"

export type PlannedReviewWorkflow = {
  readonly metadata: PullRequestMetadata
  readonly connectedWorkItems: ReadonlyArray<PullRequestWorkItem>
  readonly existingThreads: ReadonlyArray<ExistingThread>
  readonly fullPullRequestDiff: PullRequestDiff
  readonly scopedDiff: PullRequestDiff
  readonly reviewContext: ReturnType<typeof buildReviewContext>
  readonly prompt?: string
  readonly openCodeResult?: OpenCodeRunResult
  readonly reviewResult?: NormalizedReviewResult
  readonly reviewResultSource?: ReviewResultSource
  readonly summaryPrompt?: string
  readonly summaryOpenCodeResult?: OpenCodeRunResult
  readonly summaryPassOutput?: ReviewSummaryPassOutput
  readonly summaryResultSource?: ReviewResultSource
  readonly summaryFallbackUsed: boolean
  readonly summarySubjects: ReadonlyArray<ReviewSummarySubject>
  readonly summaryState: ManagedReviewState
  readonly summaryContent: string
  readonly inlineFindings: ReadonlyArray<ReviewFinding>
  readonly resolvedManagedFindingIds: ReadonlyArray<number>
  readonly actions: ReturnType<typeof reconcileThreads>
  readonly reviewMode: ReviewMode
  readonly output: ReviewWorkflowOutput
}

type SummaryRenderResult = {
  readonly renderedSummary: string
  readonly summaryPrompt?: string
  readonly summaryOpenCodeResult?: OpenCodeRunResult
  readonly summaryPassOutput?: ReviewSummaryPassOutput
  readonly summaryResultSource?: ReviewResultSource
  readonly summaryFallbackUsed: boolean
}

const REVIEW_OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: ReviewResultJsonSchema,
}

const REVIEW_SUMMARY_OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: ReviewSummaryPassOutputJsonSchema,
}

const writeStdout = Effect.fn("ReviewWorkflow.writeStdout")(function* (text: string) {
  const stdio = yield* Stdio.Stdio
  yield* Stream.make(text).pipe(Stream.run(stdio.stdout()))
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

    if (!previousSummaryState || !previousReviewedCommit) {
      return {
        reviewMode: "full",
        scopedDiff: fullPullRequestDiff,
        previousReviewedCommit,
      } satisfies ResolvedReviewScope
    }

    if (previousReviewedCommit === reviewedSourceCommit) {
      if (config.forceFullReview === true) {
        yield* logInfo("Force-full-review is enabled. Re-running a full review despite matching source commit.", {
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

      if (previousPullRequestBaseRef === fullPullRequestDiff.baseRef) {
        return {
          reviewMode: "skipped",
          previousSummaryState,
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
      const followUpContainsTargetMerge = yield* hasTargetMergeCommitInRange({
        workspace: config.workspace,
        baseRef: previousReviewedCommit,
        headRef: reviewedSourceCommit,
        currentTargetRef: fullPullRequestDiff.baseRef,
      }).pipe(Effect.orElseSucceed(() => undefined))

      if (followUpContainsTargetMerge === true) {
        yield* logInfo(
          "Follow-up range includes a merge from the target branch. Falling back to a full review to avoid reviewing target-only merge changes.",
          {
            previousReviewedCommit,
            reviewedSourceCommit,
            currentPullRequestBaseRef: fullPullRequestDiff.baseRef,
          },
        )

        return {
          reviewMode: "full",
          scopedDiff: fullPullRequestDiff,
          previousReviewedCommit,
        } satisfies ResolvedReviewScope
      }

      if (followUpContainsTargetMerge === undefined) {
        yield* logInfo(
          "Could not validate whether the follow-up range includes a merge from the target branch. Falling back to a full review.",
          {
            previousReviewedCommit,
            reviewedSourceCommit,
            currentPullRequestBaseRef: fullPullRequestDiff.baseRef,
          },
        )

        return {
          reviewMode: "full",
          scopedDiff: fullPullRequestDiff,
          previousReviewedCommit,
        } satisfies ResolvedReviewScope
      }

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

/**
 * Decodes either the provider's structured payload or repaired response text. Invalid payloads
 * are absence here so each pass can apply its own fallback without hiding decoder defects.
 */
const decodeModelOutput = Effect.fn("ReviewWorkflow.decodeModelOutput")(function* <A, E>(
  openCodeResult: OpenCodeRunResult,
  decode: (payload: Schema.Json) => Effect.Effect<A, E>,
) {
  const decodeCandidate = (payload: Schema.Json) => decode(payload).pipe(Effect.orElseSucceed(() => undefined))

  if (openCodeResult.structured !== undefined) {
    const output = yield* decodeCandidate(openCodeResult.structured)

    if (output !== undefined) {
      return { output, source: "structured" as const }
    }
  }

  // Repair can itself fail; a syntax error must still reach the pass's deterministic fallback.
  const repairedText = Option.getOrUndefined(Option.liftThrowable(jsonrepair)(openCodeResult.response))

  const repairedPayload =
    repairedText === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(repairedText).pipe(
          Effect.orElseSucceed(() => undefined),
        )

  if (repairedPayload !== undefined) {
    const output = yield* decodeCandidate(repairedPayload)

    if (output !== undefined) {
      return { output, source: "repaired" as const }
    }
  }

  return undefined
})

/** Rejects undecodable review output so a failed review never advances the persisted checkpoint. */
const decodeStructuredReviewResult = Effect.fn("ReviewWorkflow.decodeReviewResult")(function* ({
  openCodeResult,
  changedLinesByFile,
  managedFindingCandidateIds,
}: {
  readonly openCodeResult: OpenCodeRunResult
  readonly changedLinesByFile: Map<string, Set<number>>
  readonly managedFindingCandidateIds: ReadonlySet<number>
}) {
  const decoded = yield* decodeModelOutput(openCodeResult, (payload) =>
    decodeReviewResult(payload, changedLinesByFile, managedFindingCandidateIds),
  )

  if (decoded) {
    return { reviewResult: decoded.output, source: decoded.source }
  }

  return yield* new OpenCodeOutputError({
    message: "OpenCode returned no valid review result. The commit remains unreviewed; rerun the review.",
    // Model output is untrusted content and must not be echoed into failure comments or logs.
    output: "",
  })
})

const mapUsageTokens = (usage: OpenCodeRunUsage | undefined): ReviewHistoryTokens | undefined =>
  usage?.tokens
    ? {
        input: usage.tokens.input,
        output: usage.tokens.output,
        reasoning: usage.tokens.reasoning,
        cacheRead: usage.tokens.cacheRead,
        cacheWrite: usage.tokens.cacheWrite,
      }
    : undefined

/**
 * Review history tracks the total cost of a managed review run, so the two-pass review and summary
 * executions are collapsed into a single aggregate usage record before persistence.
 */
const aggregateUsage = (usages: ReadonlyArray<OpenCodeRunUsage | undefined>): OpenCodeRunUsage | undefined => {
  const definedUsages = usages.filter((usage) => usage !== undefined)

  if (definedUsages.length === 0) {
    return undefined
  }

  const totalCostUsd = definedUsages.reduce((total, usage) => total + (usage.costUsd ?? 0), 0)
  const hasAnyCost = definedUsages.some((usage) => usage.costUsd !== undefined)
  const hasAnyTokens = definedUsages.some((usage) => usage.tokens !== undefined)

  if (!hasAnyCost && !hasAnyTokens) {
    return undefined
  }

  const totalTokens = hasAnyTokens
    ? definedUsages.reduce(
        (totals, usage) => ({
          input: totals.input + (usage.tokens?.input ?? 0),
          output: totals.output + (usage.tokens?.output ?? 0),
          reasoning: totals.reasoning + (usage.tokens?.reasoning ?? 0),
          cacheRead: totals.cacheRead + (usage.tokens?.cacheRead ?? 0),
          cacheWrite: totals.cacheWrite + (usage.tokens?.cacheWrite ?? 0),
        }),
        {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      )
    : undefined

  let usage: OpenCodeRunUsage = {}

  if (hasAnyCost) {
    usage = { ...usage, costUsd: totalCostUsd }
  }

  if (totalTokens) {
    usage = { ...usage, tokens: totalTokens }
  }

  return usage
}

/**
 * Runs the summary-only pass against the already publishable subject list and returns either the
 * validated grouped highlights or a deterministic fallback render.
 */
const runReviewSummaryPass = ({
  config,
  openCodeRunner,
  reviewMode,
  reviewResult,
  summarySubjects,
}: {
  readonly config: ReviewWorkflowConfig
  readonly openCodeRunner: OpenCodeRunner["Service"]
  readonly reviewMode: ReviewMode
  readonly reviewResult: NormalizedReviewResult
  readonly summarySubjects: ReadonlyArray<ReviewSummarySubject>
}) =>
  Effect.gen(function* () {
    if (summarySubjects.length === 0) {
      yield* logInfo("Skipped summary pass because there were no summary subjects to group.")

      return {
        renderedSummary: renderReviewSummaryFallback({
          verdict: reviewResult.verdict,
          reviewMode,
          subjects: summarySubjects,
        }),
        summaryFallbackUsed: false,
      } satisfies SummaryRenderResult
    }

    const summaryPrompt = buildReviewSummaryPrompt(summarySubjects)
    yield* logInfo(`Built summary prompt for ${summarySubjects.length} summary subject(s).`)

    const summaryRunExit = yield* Effect.exit(
      openCodeRunner.run({
        workspace: config.workspace,
        model: config.model,
        agent: config.agent,
        variant: config.opencodeVariant,
        timeout: config.opencodeTimeout,
        prompt: summaryPrompt,
        inheritedEnv: config.inheritedEnv,
        format: REVIEW_SUMMARY_OUTPUT_FORMAT,
      }),
    )

    if (Exit.isFailure(summaryRunExit)) {
      // A typed runner error cannot invalidate a completed review. Defects and cancellation still propagate.
      if (Cause.hasInterrupts(summaryRunExit.cause) || Cause.hasDies(summaryRunExit.cause)) {
        return yield* Effect.failCause(summaryRunExit.cause)
      }

      yield* logInfo("Falling back to deterministic summary rendering because the optional summary run failed.")

      return {
        renderedSummary: renderReviewSummaryFallback({
          verdict: reviewResult.verdict,
          reviewMode,
          subjects: summarySubjects,
        }),
        summaryPrompt,
        summaryResultSource: "fallback",
        summaryFallbackUsed: true,
      } satisfies SummaryRenderResult
    }

    const summaryOpenCodeResult = summaryRunExit.value

    yield* logInfo("Received OpenCode summary response.")

    const decodedSummaryResult = yield* decodeModelOutput(summaryOpenCodeResult, decodeReviewSummaryPassOutput)

    if (!decodedSummaryResult) {
      yield* logInfo("Falling back to deterministic summary rendering because summary output was not decodable.")

      return {
        renderedSummary: renderReviewSummaryFallback({
          verdict: reviewResult.verdict,
          reviewMode,
          subjects: summarySubjects,
        }),
        summaryPrompt,
        summaryOpenCodeResult,
        summaryResultSource: "fallback",
        summaryFallbackUsed: true,
      } satisfies SummaryRenderResult
    }

    const validatedSummaryResult = validateReviewSummaryPassOutput({
      subjects: summarySubjects,
      output: decodedSummaryResult.output,
    })

    if (!validatedSummaryResult.ok) {
      yield* logInfo("Falling back to deterministic summary rendering because summary validation failed.", {
        issues: validatedSummaryResult.issues,
      })

      return {
        renderedSummary: renderReviewSummaryFallback({
          verdict: reviewResult.verdict,
          reviewMode,
          subjects: summarySubjects,
        }),
        summaryPrompt,
        summaryOpenCodeResult,
        summaryResultSource: "fallback",
        summaryFallbackUsed: true,
      } satisfies SummaryRenderResult
    }

    return {
      renderedSummary: renderReviewSummaryFromHighlights({
        verdict: reviewResult.verdict,
        reviewMode,
        subjects: summarySubjects,
        output: validatedSummaryResult.output,
      }),
      summaryPrompt,
      summaryOpenCodeResult,
      summaryPassOutput: validatedSummaryResult.output,
      summaryResultSource: decodedSummaryResult.source,
      summaryFallbackUsed: false,
    } satisfies SummaryRenderResult
  })

/** Builds a persisted run record while preserving absence for usage and build fields not supplied. */
const buildReviewHistoryEntry = ({
  reviewedCommit,
  reviewMode,
  config,
  buildLink,
  usage,
}: {
  readonly reviewedCommit: string
  readonly reviewMode: Exclude<ReviewMode, "skipped">
  readonly config: ReviewWorkflowConfig
  readonly buildLink?: string | undefined
  readonly usage?: OpenCodeRunUsage | undefined
}): ReviewHistoryEntry => {
  const tokens = mapUsageTokens(usage)

  let entry: ReviewHistoryEntry = {
    reviewedCommit,
    reviewedAt: new Date().toISOString(),
    reviewMode,
    model: config.model,
  }

  if (config.opencodeVariant) {
    entry = { ...entry, variant: config.opencodeVariant }
  }

  if (config.buildNumber) {
    entry = { ...entry, buildNumber: config.buildNumber }
  }

  if (config.buildId) {
    entry = { ...entry, buildId: config.buildId }
  }

  if (buildLink) {
    entry = { ...entry, buildLink }
  }

  if (usage?.costUsd !== undefined) {
    entry = { ...entry, costUsd: usage.costUsd }
  }

  if (tokens) {
    entry = { ...entry, tokens }
  }

  return entry
}

const appendReviewHistoryEntry = ({
  previousSummaryState,
  reviewedCommit,
  reviewMode,
  config,
  buildLink,
  usage,
}: {
  readonly previousSummaryState: ManagedReviewState | undefined
  readonly reviewedCommit: string
  readonly reviewMode: Exclude<ReviewMode, "skipped">
  readonly config: ReviewWorkflowConfig
  readonly buildLink?: string | undefined
  readonly usage?: OpenCodeRunUsage | undefined
}): ReadonlyArray<ReviewHistoryEntry> => [
  ...(previousSummaryState?.reviewHistory ?? []),
  buildReviewHistoryEntry({
    reviewedCommit,
    reviewMode,
    config,
    buildLink,
    usage,
  }),
]

const writeReviewWorkflowOutput = (config: ReviewWorkflowConfig, output: ReviewWorkflowOutput) => {
  if (config.json) {
    return writeStdout(
      `${JSON.stringify({
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

  return writeStdout(
    `Posted review verdict ${output.verdict} with ${output.findingsCount} ${output.findingsCount === 1 ? "finding" : "findings"}.\n`,
  )
}

const planAuthenticatedReview = Effect.fn("ReviewWorkflow.planAuthenticated")(function* (
  config: ReviewWorkflowConfig,
  azureContext: AzureContext,
  buildLink: string | undefined,
  authenticatedIdentity: string,
) {
  const azureClient = yield* AzureDevOpsClient
  const openCodeRunner = yield* OpenCodeRunner

  yield* logInfo(`Resolved review configuration for ${config.model}.`)
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

  yield* logInfo(`Loaded review inputs for ${fullPullRequestDiff.changedFiles.length} changed file(s).`)

  const managedThreads = decodeManagedThreads(existingThreads, authenticatedIdentity)
  const previousSummaryState = managedThreads.summary?.reviewState

  const scope = yield* resolveReviewScope({
    config,
    fullPullRequestDiff,
    reviewedSourceCommit,
    previousSummaryState,
  })

  // The skipped scope carries its prior state, so later review history needs no mode assertion.
  const { reviewMode, scopedDiff, previousReviewedCommit } = scope

  if (reviewMode === "skipped") {
    const previousSummaryState = scope.previousSummaryState

    const summaryContent = buildSummaryComment({
      verdict: previousSummaryState.verdict,
      summary: "⏭️ No new commits since the last managed review. Previous verdict still applies.",
      unmappedNotes: [],
      severityCounts: previousSummaryState.severityCounts,
      buildLink,
      persistedState: previousSummaryState,
    })

    const actions = reconcileThreads({
      managedThreads,
      summaryContent,
      summaryVerdict: previousSummaryState.verdict,
      inlineFindings: [],
      resolvedManagedFindingIds: [],
      reviewMode,
      scopedChangedLinesByFile: scopedDiff.changedLinesByFile,
      scopedDeletedLinesByFile: scopedDiff.deletedLinesByFile,
    })

    yield* logInfo("Skipped review because no new commits were added since the last managed review.")

    return {
      metadata,
      connectedWorkItems: [],
      existingThreads,
      fullPullRequestDiff,
      scopedDiff,
      reviewContext: buildReviewContext({
        metadata,
        reviewMode,
        previousReviewedCommit,
        pullRequestBaseRef: fullPullRequestDiff.baseRef,
        gitDiff: scopedDiff,
        existingThreads,
        managedThreads,
      }),
      summaryFallbackUsed: false,
      summarySubjects: [],
      summaryState: previousSummaryState,
      summaryContent,
      inlineFindings: [],
      resolvedManagedFindingIds: [],
      actions,
      reviewMode,
      output: {
        findingsCount: previousSummaryState.findingsCount,
        inlineFindingsCount: previousSummaryState.inlineFindingsCount,
        unmappedNotesCount: previousSummaryState.unmappedNotesCount,
        verdict: previousSummaryState.verdict,
        buildSummary: summaryContent,
        actionCount: actions.length,
        reviewMode,
        skipped: true,
      },
    } satisfies PlannedReviewWorkflow
  }

  const connectedWorkItems = yield* azureClient
    .getPullRequestWorkItems({
      context: azureContext,
      token: config.systemAccessToken,
      workItemRefs: metadata.workItemRefs,
    })
    .pipe(
      Effect.tap((workItems) =>
        logInfo(
          workItems.length > 0
            ? `Loaded ${workItems.length} connected work item(s).`
            : "No connected work items found.",
        ),
      ),
      Effect.catchTags({
        AzureDevOpsHttpError: (error) =>
          logInfo("Failed to load connected work item context. Continuing without work item enrichment.", {
            workItemRefs: metadata.workItemRefs.length,
            status: error.status,
            url: error.url,
          }).pipe(Effect.as(undefined)),
        AzureDevOpsDecodeError: (error) =>
          logInfo("Failed to decode connected work item context. Continuing without work item enrichment.", {
            workItemRefs: metadata.workItemRefs.length,
            url: error.url,
          }).pipe(Effect.as(undefined)),
      }),
    )

  const reviewContext = buildReviewContext({
    metadata,
    reviewMode,
    previousReviewedCommit,
    pullRequestBaseRef: fullPullRequestDiff.baseRef,
    gitDiff: scopedDiff,
    existingThreads,
    managedThreads,
    connectedWorkItems,
  })

  yield* logInfo(`Built ${reviewMode} review context.`)

  const prompt = yield* buildReviewPrompt(config.promptFile, reviewContext)
  yield* logInfo("Built review prompt.")

  const managedFindingCandidateIds = new Set(reviewContext.managedFindingCandidates?.items.map((item) => item.id) ?? [])

  const openCodeResult = yield* openCodeRunner.run({
    workspace: config.workspace,
    model: config.model,
    agent: config.agent,
    variant: config.opencodeVariant,
    timeout: config.opencodeTimeout,
    prompt,
    inheritedEnv: config.inheritedEnv,
    format: REVIEW_OUTPUT_FORMAT,
  })

  yield* logInfo("Received OpenCode response.")

  const { reviewResult, source } = yield* decodeStructuredReviewResult({
    openCodeResult,
    changedLinesByFile: scopedDiff.changedLinesByFile,
    managedFindingCandidateIds,
  })

  yield* logInfo(`Decoded review result: ${reviewResult.verdict} with ${reviewResult.findings.length} finding(s).`)

  const mergedReview = mergeManagedReviewResult({
    managedThreads,
    scopedChangedLinesByFile: scopedDiff.changedLinesByFile,
    scopedDeletedLinesByFile: scopedDiff.deletedLinesByFile,
    reviewResult,
  })

  const outstandingReviewResult = mergedReview.reviewResult

  const summarySubjects = buildReviewSummarySubjects({
    reviewResult: outstandingReviewResult,
    retainedFindings: mergedReview.retainedFindings,
  })

  const summaryRender = yield* runReviewSummaryPass({
    config,
    openCodeRunner,
    reviewMode,
    reviewResult: outstandingReviewResult,
    summarySubjects,
  })

  const reviewHistory = appendReviewHistoryEntry({
    previousSummaryState,
    reviewedCommit: reviewedSourceCommit,
    reviewMode,
    config,
    buildLink,
    usage: aggregateUsage([openCodeResult.usage, summaryRender.summaryOpenCodeResult?.usage]),
  })

  const summaryState = buildManagedReviewState({
    reviewedCommit: reviewedSourceCommit,
    pullRequestBaseRef: fullPullRequestDiff.baseRef,
    reviewResult: outstandingReviewResult,
    reviewHistory,
  })

  const { renderedSummary, ...summaryArtifacts } = summaryRender

  const summaryContent = buildSummaryComment({
    verdict: summaryState.verdict,
    summary: renderedSummary,
    unmappedNotes: outstandingReviewResult.unmappedNotes,
    severityCounts: summaryState.severityCounts,
    buildLink,
    persistedState: summaryState,
  })

  const actions = reconcileThreads({
    managedThreads,
    summaryContent,
    summaryVerdict: summaryState.verdict,
    inlineFindings: reviewResult.inlineFindings,
    resolvedManagedFindingIds: reviewResult.resolvedManagedFindingIds,
    reviewMode,
    scopedChangedLinesByFile: scopedDiff.changedLinesByFile,
    scopedDeletedLinesByFile: scopedDiff.deletedLinesByFile,
  })

  yield* logInfo(`Prepared ${actions.length} review action(s).`)

  const plan: PlannedReviewWorkflow = {
    metadata,
    connectedWorkItems: connectedWorkItems ?? [],
    existingThreads,
    fullPullRequestDiff,
    scopedDiff,
    reviewContext,
    prompt,
    openCodeResult,
    reviewResult: outstandingReviewResult,
    reviewResultSource: source,
    ...summaryArtifacts,
    summarySubjects,
    summaryState,
    summaryContent,
    inlineFindings: reviewResult.inlineFindings,
    resolvedManagedFindingIds: reviewResult.resolvedManagedFindingIds,
    actions,
    reviewMode,
    output: {
      findingsCount: summaryState.findingsCount,
      inlineFindingsCount: summaryState.inlineFindingsCount,
      unmappedNotesCount: summaryState.unmappedNotesCount,
      verdict: summaryState.verdict,
      buildSummary: summaryContent,
      actionCount: actions.length,
      reviewMode,
      skipped: false,
    },
  }

  return plan
}, Effect.withLogSpan("open-azdo.review"))

/** Plans a review or capture after resolving the access token's marker authority exactly once. */
export const planReviewWorkflow = Effect.fn("ReviewWorkflow.plan")(function* (
  config: ReviewWorkflowConfig,
  azureContext: AzureContext,
  buildLink: string | undefined,
) {
  const azureClient = yield* AzureDevOpsClient

  const authenticatedIdentity = yield* azureClient.getAuthenticatedIdentity({
    context: azureContext,
    token: config.systemAccessToken,
  })

  return yield* planAuthenticatedReview(config, azureContext, buildLink, authenticatedIdentity)
})

/** Publishes finding mutations before committing the summary checkpoint; any failure remains retryable. */
export const runReviewWorkflow = Effect.fn("ReviewWorkflow.run")(function* (config: ReviewWorkflowConfig) {
  const azureContext = createAzureContext(config)
  const buildLink = buildBuildLink(config)
  const azureClient = yield* AzureDevOpsClient

  const authenticatedIdentity = yield* azureClient.getAuthenticatedIdentity({
    context: azureContext,
    token: config.systemAccessToken,
  })

  const exit = yield* Effect.exit(
    Effect.gen(function* () {
      const planned = yield* planAuthenticatedReview(config, azureContext, buildLink, authenticatedIdentity)

      const published = yield* publishReview({
        context: azureContext,
        token: config.systemAccessToken,
        authenticatedIdentity,
        dryRun: config.dryRun,
        summaryContent: planned.summaryContent,
        summaryVerdict: planned.summaryState.verdict,
        inlineFindings: planned.inlineFindings,
        resolvedManagedFindingIds: planned.resolvedManagedFindingIds,
        reviewMode: planned.reviewMode,
        scopedChangedLinesByFile: planned.scopedDiff.changedLinesByFile,
        scopedDeletedLinesByFile: planned.scopedDiff.deletedLinesByFile,
      })

      return { ...planned.output, buildSummary: published.summaryContent, actionCount: published.actions.length }
    }),
  )

  if (Exit.isSuccess(exit)) {
    yield* writeReviewWorkflowOutput(config, exit.value)

    return 0
  }

  if (Cause.hasInterrupts(exit.cause)) {
    return yield* Effect.failCause(exit.cause)
  }

  const failureReason = "The review could not be completed. See the pipeline logs for details."

  // A failed listing is not an empty authoritative view. Failure publication remains best effort,
  // and can only reuse state freshly decoded from this token's nondeleted comments.
  yield* azureClient.listThreads({ context: azureContext, token: config.systemAccessToken }).pipe(
    Effect.flatMap((threads) =>
      publishFailureSummary({
        context: azureContext,
        token: config.systemAccessToken,
        dryRun: config.dryRun,
        buildLink,
        managedThreads: decodeManagedThreads(threads, authenticatedIdentity),
        failureReason,
      }),
    ),
    Effect.ignore,
  )

  yield* logError("open-azdo failed.", { cause: Cause.pretty(exit.cause) })

  return 1
})
