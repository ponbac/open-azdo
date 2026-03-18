import { Effect } from "effect"
import type { Redacted } from "effect"
import type { AzureContext } from "@open-azdo/azdo/context"
import { AzureDevOpsClient } from "@open-azdo/azdo/client"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import { normalizePath } from "@open-azdo/core/paths"

import type { NormalizedReviewResult, ReviewResult, ReviewFinding } from "./ReviewOutput"
import {
  buildSummaryComment,
  findManagedSummaryThread,
  reconcileThreads,
  type ThreadAction,
} from "./ThreadReconciliation"

export type PublishReviewInput = {
  readonly context: AzureContext
  readonly token: Redacted.Redacted<string>
  readonly dryRun: boolean
  readonly buildLink: string | undefined
  readonly reviewResult: NormalizedReviewResult
}

export type PublishFailureSummaryInput = {
  readonly context: AzureContext
  readonly token: Redacted.Redacted<string>
  readonly dryRun: boolean
  readonly buildLink: string | undefined
  readonly failureReason: string
}

export type PublishReviewResult = {
  readonly actions: ReadonlyArray<ThreadAction>
  readonly existingThreads: ReadonlyArray<ExistingThread>
}

export type PublishFailureSummaryResult = {
  readonly content: string
  readonly existingSummary:
    | {
        readonly thread: ExistingThread
        readonly commentId: number
      }
    | undefined
}

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

const applyThreadAction = (
  client: AzureDevOpsClient["Service"],
  context: AzureContext,
  token: Redacted.Redacted<string>,
  action: ThreadAction,
) => {
  switch (action.type) {
    case "upsert-summary":
      return upsertThreadComment(
        client,
        context,
        token,
        action.content,
        undefined,
        action.existingThread,
        action.commentId,
      )
    case "upsert-finding":
      return upsertThreadComment(
        client,
        context,
        token,
        action.content,
        createInlineThreadContext(action.finding),
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
  buildLink,
  reviewResult,
}: PublishReviewInput): Effect.Effect<PublishReviewResult, unknown, AzureDevOpsClient> =>
  Effect.gen(function* () {
    const client = yield* AzureDevOpsClient
    const existingThreads = yield* client.listThreads({ context, token })
    const actions = reconcileThreads(existingThreads, reviewResult, reviewResult.inlineFindings, buildLink)

    if (!dryRun) {
      for (const action of actions) {
        yield* applyThreadAction(client, context, token, action)
      }
    }

    return { actions, existingThreads }
  })

export const publishFailureSummary = ({
  context,
  token,
  dryRun,
  buildLink,
  failureReason,
}: PublishFailureSummaryInput): Effect.Effect<PublishFailureSummaryResult, unknown, AzureDevOpsClient> =>
  Effect.gen(function* () {
    const client = yield* AzureDevOpsClient
    const existingThreads = yield* client.listThreads({ context, token })
    const reviewResult: ReviewResult = {
      summary: `Review execution failed.\n\n${failureReason}`,
      verdict: "fail",
      findings: [],
      unmappedNotes: [],
    }
    const content = buildSummaryComment(reviewResult, buildLink)
    const existingSummary = findManagedSummaryThread(existingThreads)

    if (!dryRun) {
      yield* upsertThreadComment(
        client,
        context,
        token,
        content,
        undefined,
        existingSummary?.thread,
        existingSummary?.commentId,
      )
    }

    return {
      content,
      existingSummary,
    }
  })
