import { Effect } from "effect"
import type { Redacted } from "effect"
import type { AzureContext } from "@open-azdo/azdo/context"
import { AzureDevOpsClient } from "@open-azdo/azdo/client"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import { normalizePath } from "@open-azdo/core/paths"

import type { ReviewMode } from "./ReviewContext"
import type { ManagedReviewState, ThreadAction } from "./ThreadReconciliation"
import { buildSummaryComment, findManagedSummaryThread, reconcileThreads } from "./ThreadReconciliation"
import type { ReviewFinding } from "./ReviewOutput"

export type PublishReviewInput = {
  readonly context: AzureContext
  readonly token: Redacted.Redacted<string>
  readonly dryRun: boolean
  readonly summaryContent: string
  readonly inlineFindings: ReadonlyArray<ReviewFinding>
  readonly resolvedManagedFindingIds: ReadonlyArray<number>
  readonly reviewMode: ReviewMode
  readonly scopedChangedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
  readonly scopedDeletedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
}

export type PublishFailureSummaryInput = {
  readonly context: AzureContext
  readonly token: Redacted.Redacted<string>
  readonly dryRun: boolean
  readonly buildLink: string | undefined
  readonly existingThreads?: ReadonlyArray<ExistingThread> | undefined
  readonly failureReason: string
  readonly preservedSummaryState?: ManagedReviewState | undefined
}

export type PublishReviewResult = {
  readonly actions: ReadonlyArray<ThreadAction>
  readonly summaryContent: string
}

const EMPTY_SEVERITY_COUNTS = {
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
} as const

const createInlineThreadContext = (finding: ReviewFinding) => ({
  filePath: `/${normalizePath(finding.filePath)}`,
  rightFileStart: { line: finding.line, offset: 1 },
  rightFileEnd: { line: finding.endLine ?? finding.line, offset: 1 },
})

const upsertThreadComment = (
  client: AzureDevOpsClient["Service"],
  context: AzureContext,
  token: Redacted.Redacted<string>,
  content: string,
  threadContext: Record<string, unknown> | undefined,
  existingThread: ExistingThread | undefined,
  commentId: number | undefined,
) =>
  !existingThread || !commentId
    ? client.createThread({ context, token, content, threadContext })
    : Effect.all([
        client.updateComment({
          context,
          token,
          threadId: existingThread.id,
          commentId,
          content,
        }),
        client.updateThreadStatus({
          context,
          token,
          threadId: existingThread.id,
          status: 1,
        }),
      ]).pipe(Effect.asVoid)

const upsertSummaryThread = (
  client: AzureDevOpsClient["Service"],
  context: AzureContext,
  token: Redacted.Redacted<string>,
  content: string,
  existingThread: ExistingThread | undefined,
  commentId: number | undefined,
) => upsertThreadComment(client, context, token, content, undefined, existingThread, commentId)

const upsertFindingThread = (
  client: AzureDevOpsClient["Service"],
  context: AzureContext,
  token: Redacted.Redacted<string>,
  content: string,
  finding: ReviewFinding,
  existingThread: ExistingThread | undefined,
  commentId: number | undefined,
) => upsertThreadComment(client, context, token, content, createInlineThreadContext(finding), existingThread, commentId)

const applyThreadAction = (
  client: AzureDevOpsClient["Service"],
  context: AzureContext,
  token: Redacted.Redacted<string>,
  action: ThreadAction,
) => {
  switch (action.type) {
    case "upsert-summary":
      return upsertSummaryThread(client, context, token, action.content, action.existingThread, action.commentId)
    case "upsert-finding":
      return upsertFindingThread(
        client,
        context,
        token,
        action.content,
        action.finding,
        action.existingThread,
        action.commentId,
      )
    case "close-thread":
      return client.updateThreadStatus({
        context,
        token,
        threadId: action.existingThread.id,
        status: 2,
      })
  }
}

export const publishReview = ({
  context,
  token,
  dryRun,
  summaryContent,
  inlineFindings,
  resolvedManagedFindingIds,
  reviewMode,
  scopedChangedLinesByFile,
  scopedDeletedLinesByFile,
}: PublishReviewInput): Effect.Effect<PublishReviewResult, unknown, AzureDevOpsClient> =>
  Effect.gen(function* () {
    const client = yield* AzureDevOpsClient
    const existingThreads = yield* client.listThreads({ context, token })
    const actions = reconcileThreads({
      existingThreads,
      summaryContent,
      inlineFindings,
      resolvedManagedFindingIds,
      reviewMode,
      scopedChangedLinesByFile,
      scopedDeletedLinesByFile,
    })

    if (!dryRun) {
      yield* Effect.forEach(actions, (action) => applyThreadAction(client, context, token, action), {
        discard: true,
      })
    }

    return { actions, summaryContent }
  })

export const publishFailureSummary = ({
  context,
  token,
  dryRun,
  buildLink,
  existingThreads: providedExistingThreads,
  failureReason,
  preservedSummaryState,
}: PublishFailureSummaryInput): Effect.Effect<void, unknown, AzureDevOpsClient> =>
  Effect.gen(function* () {
    const client = yield* AzureDevOpsClient
    const existingThreads = providedExistingThreads
      ? providedExistingThreads
      : yield* client.listThreads({ context, token })
    const existingSummary = findManagedSummaryThread(existingThreads)
    const summaryContent = buildSummaryComment({
      verdict: "fail",
      summary: `Review execution failed.\n\n${failureReason}`,
      unmappedNotes: [],
      severityCounts: EMPTY_SEVERITY_COUNTS,
      buildLink,
      persistedState: preservedSummaryState,
    })

    if (!dryRun) {
      yield* upsertSummaryThread(
        client,
        context,
        token,
        summaryContent,
        existingSummary?.thread,
        existingSummary?.commentId,
      )
    }
  })
