import { Effect } from "effect"
import type { Redacted } from "effect"
import type { AzureContext } from "@open-azdo/azdo/context"
import { AzureDevOpsClient, type CreateThreadContext, type WritableThreadStatus } from "@open-azdo/azdo/client"
import type { ExistingThread } from "@open-azdo/azdo/schemas"

import type { ReviewMode } from "./ReviewContext"
import type { ThreadAction, ManagedThreads } from "./ThreadReconciliation"
import { buildFailureSummaryComment, decodeManagedThreads, reconcileThreads } from "./ThreadReconciliation"
import type { NormalizedReviewResult, ReviewFinding } from "./ReviewOutput"

export type PublishReviewInput = {
  readonly context: AzureContext
  readonly token: Redacted.Redacted<string>
  readonly dryRun: boolean
  readonly authenticatedIdentity: string
  readonly summaryContent: string
  readonly summaryVerdict: NormalizedReviewResult["verdict"]
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
  readonly managedThreads: ManagedThreads
  readonly failureReason: string
}

export type PublishReviewResult = {
  readonly actions: ReadonlyArray<ThreadAction>
  readonly summaryContent: string
}

const createInlineThreadContext = (finding: ReviewFinding) => ({
  // Normalization already resolved the exact Git path; backslashes can be filename characters.
  filePath: `/${finding.filePath}`,
  rightFileStart: { line: finding.line, offset: 1 },
  rightFileEnd: { line: finding.endLine ?? finding.line, offset: 1 },
})

/**
 * Creates a thread with the given comment, or rewrites the managed comment of an existing thread.
 * Either way the thread ends up in `status`, so a resolved thread is reopened (or vice versa) to
 * match the latest review. Status is written first so summary checkpoint content is the final
 * remote mutation after every required finding and status write has succeeded.
 */
const upsertThreadComment = Effect.fn("ReviewPublisher.upsertThreadComment")(function* (
  client: AzureDevOpsClient["Service"],
  context: AzureContext,
  token: Redacted.Redacted<string>,
  content: string,
  threadContext: CreateThreadContext | undefined,
  existingThread: ExistingThread | undefined,
  commentId: number | undefined,
  status: WritableThreadStatus,
) {
  if (!existingThread || !commentId) {
    return yield* client.createThread({ context, token, content, threadContext, status })
  }

  yield* client.updateThreadStatus({ context, token, threadId: existingThread.id, status })
  yield* client.updateComment({ context, token, threadId: existingThread.id, commentId, content })
})

const upsertSummaryThread = (
  client: AzureDevOpsClient["Service"],
  context: AzureContext,
  token: Redacted.Redacted<string>,
  content: string,
  existingThread: ExistingThread | undefined,
  commentId: number | undefined,
  resolved: boolean,
) => upsertThreadComment(client, context, token, content, undefined, existingThread, commentId, resolved ? 2 : 1)

const upsertFindingThread = (
  client: AzureDevOpsClient["Service"],
  context: AzureContext,
  token: Redacted.Redacted<string>,
  content: string,
  finding: ReviewFinding,
  existingThread: ExistingThread | undefined,
  commentId: number | undefined,
) =>
  upsertThreadComment(client, context, token, content, createInlineThreadContext(finding), existingThread, commentId, 1)

const applyThreadAction = (
  client: AzureDevOpsClient["Service"],
  context: AzureContext,
  token: Redacted.Redacted<string>,
  action: ThreadAction,
) => {
  switch (action.type) {
    case "upsert-summary":
      return upsertSummaryThread(
        client,
        context,
        token,
        action.content,
        action.existingThread,
        action.commentId,
        action.resolved,
      )
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

/** Reconciles a fresh trusted listing and applies findings before the summary commit point. */
export const publishReview = Effect.fn("ReviewPublisher.publishReview")(function* ({
  context,
  token,
  dryRun,
  authenticatedIdentity,
  summaryContent,
  summaryVerdict,
  inlineFindings,
  resolvedManagedFindingIds,
  reviewMode,
  scopedChangedLinesByFile,
  scopedDeletedLinesByFile,
}: PublishReviewInput) {
  const client = yield* AzureDevOpsClient
  const existingThreads = yield* client.listThreads({ context, token })

  const actions = reconcileThreads({
    managedThreads: decodeManagedThreads(existingThreads, authenticatedIdentity),
    summaryContent,
    summaryVerdict,
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

/** Reports failure in its own authenticated notice, leaving the committed summary untouched. */
export const publishFailureSummary = Effect.fn("ReviewPublisher.publishFailureSummary")(function* ({
  context,
  token,
  dryRun,
  buildLink,
  managedThreads,
  failureReason,
}: PublishFailureSummaryInput) {
  const client = yield* AzureDevOpsClient

  const existingFailure = managedThreads.failure

  const summaryContent = buildFailureSummaryComment({
    summary: `Review execution failed.\n\n${failureReason}`,
    buildLink,
  })

  if (!dryRun) {
    yield* upsertSummaryThread(
      client,
      context,
      token,
      summaryContent,
      existingFailure?.thread,
      existingFailure?.commentId,
      false,
    )
  }
})
