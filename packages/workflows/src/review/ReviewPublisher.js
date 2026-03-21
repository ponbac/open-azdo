import { Effect } from "effect"
import { AzureDevOpsClient } from "@open-azdo/azdo/client"
import { normalizePath } from "@open-azdo/core/paths"
import { buildSummaryComment, findManagedSummaryThread, reconcileThreads } from "./ThreadReconciliation"
const EMPTY_SEVERITY_COUNTS = {
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
}
const createInlineThreadContext = (finding) => ({
  filePath: `/${normalizePath(finding.filePath)}`,
  rightFileStart: { line: finding.line, offset: 1 },
  rightFileEnd: { line: finding.endLine ?? finding.line, offset: 1 },
})
const upsertThreadComment = (client, context, token, content, threadContext, existingThread, commentId) =>
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
const upsertSummaryThread = (client, context, token, content, existingThread, commentId) =>
  upsertThreadComment(client, context, token, content, undefined, existingThread, commentId)
const upsertFindingThread = (client, context, token, content, finding, existingThread, commentId) =>
  upsertThreadComment(client, context, token, content, createInlineThreadContext(finding), existingThread, commentId)
const applyThreadAction = (client, context, token, action) => {
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
  reviewMode,
  scopedChangedLinesByFile,
  scopedDeletedLinesByFile,
}) =>
  Effect.gen(function* () {
    const client = yield* AzureDevOpsClient
    const existingThreads = yield* client.listThreads({ context, token })
    const actions = reconcileThreads({
      existingThreads,
      summaryContent,
      inlineFindings,
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
}) =>
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
