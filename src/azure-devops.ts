import { Effect, Redacted } from "effect"

import { createAzureContext, type AzureContext, type ReviewConfig } from "./config"
import { AzureDevOpsHttpError } from "./errors"
import { parseJsonString, stringifyJson } from "./json"
import type { NormalizedReviewResult, ReviewFinding, ReviewResult } from "./review-output"
import { normalizePath } from "./review-output"
import {
  buildSummaryComment,
  findManagedSummaryThread,
  reconcileThreads,
  type ExistingThread,
  type ThreadAction,
} from "./thread-reconciliation"

export type PullRequestMetadata = {
  title: string
  description: string
  url: string | undefined
}

export type FetchLike = typeof fetch

export const getPullRequestMetadata = Effect.fn("azureDevOps.getPullRequestMetadata")(function* (
  context: AzureContext,
  token: Redacted.Redacted<string>,
  fetchLike: FetchLike = fetch,
) {
  return yield* requestJson<PullRequestMetadata>(
    buildPullRequestUrl(context),
    {
      method: "GET",
      headers: createHeaders(token),
    },
    fetchLike,
  )
})

export const listThreads = Effect.fn("azureDevOps.listThreads")(function* (
  context: AzureContext,
  token: Redacted.Redacted<string>,
  fetchLike: FetchLike = fetch,
) {
  const response = yield* requestJson<{ value: ExistingThread[] }>(
    `${buildPullRequestUrl(context)}/threads?api-version=7.1`,
    {
      method: "GET",
      headers: createHeaders(token),
    },
    fetchLike,
  )

  return response.value ?? []
})

export const publishReview = Effect.fn("azureDevOps.publishReview")(function* (
  config: ReviewConfig,
  reviewResult: NormalizedReviewResult,
  fetchLike: FetchLike = fetch,
) {
  const context = createAzureContext(config)
  const existingThreads = yield* listThreads(context, config.systemAccessToken, fetchLike)
  const actions = reconcileThreads(
    existingThreads,
    reviewResult,
    reviewResult.inlineFindings,
    buildLinkFromConfig(config),
  )

  if (config.dryRun) {
    return {
      actions,
      existingThreads,
    }
  }

  for (const action of actions) {
    yield* applyThreadAction(context, config.systemAccessToken, action, fetchLike)
  }

  return {
    actions,
    existingThreads,
  }
})

export const publishFailureSummary = Effect.fn("azureDevOps.publishFailureSummary")(function* (
  config: ReviewConfig,
  failureReason: string,
  fetchLike: FetchLike = fetch,
) {
  const context = createAzureContext(config)
  const existingThreads = yield* listThreads(context, config.systemAccessToken, fetchLike)
  const reviewResult: ReviewResult = {
    summary: `Review execution failed.\n\n${failureReason}`,
    verdict: "fail",
    findings: [],
    unmappedNotes: [],
  }
  const content = buildSummaryComment(reviewResult, buildLinkFromConfig(config))
  const existingSummary = findManagedSummaryThread(existingThreads)

  if (config.dryRun) {
    return {
      content,
      existingSummary,
    }
  }

  yield* upsertThreadComment(
    context,
    config.systemAccessToken,
    content,
    undefined,
    existingSummary?.thread,
    existingSummary?.commentId,
    fetchLike,
  )

  return {
    content,
    existingSummary,
  }
})

const applyThreadAction = Effect.fn("azureDevOps.applyThreadAction")(function* (
  context: AzureContext,
  token: Redacted.Redacted<string>,
  action: ThreadAction,
  fetchLike: FetchLike = fetch,
) {
  switch (action.type) {
    case "upsert-summary": {
      yield* upsertThreadComment(
        context,
        token,
        action.content,
        undefined,
        action.existingThread,
        action.commentId,
        fetchLike,
      )
      return
    }
    case "upsert-finding": {
      yield* upsertThreadComment(
        context,
        token,
        action.content,
        createInlineThreadContext(action.finding),
        action.existingThread,
        action.commentId,
        fetchLike,
      )
      return
    }
    case "close-thread": {
      yield* updateThreadStatus(context, token, action.existingThread.id, 2, fetchLike)
      return
    }
  }
})

const upsertThreadComment = Effect.fn("azureDevOps.upsertThreadComment")(function* (
  context: AzureContext,
  token: Redacted.Redacted<string>,
  content: string,
  threadContext: Record<string, unknown> | undefined,
  existingThread: ExistingThread | undefined,
  commentId: number | undefined,
  fetchLike: FetchLike = fetch,
) {
  if (!existingThread || !commentId) {
    yield* createThread(context, token, content, threadContext, fetchLike)
    return
  }

  yield* updateComment(context, token, existingThread.id, commentId, content, fetchLike)
  yield* updateThreadStatus(context, token, existingThread.id, 1, fetchLike)
})

const createThread = Effect.fn("azureDevOps.createThread")(function* (
  context: AzureContext,
  token: Redacted.Redacted<string>,
  content: string,
  threadContext: Record<string, unknown> | undefined,
  fetchLike: FetchLike = fetch,
) {
  return yield* requestJson(
    `${buildPullRequestUrl(context)}/threads?api-version=7.1`,
    {
      method: "POST",
      headers: createHeaders(token),
      body: stringifyJson({
        comments: [
          {
            parentCommentId: 0,
            content,
            commentType: 1,
          },
        ],
        status: 1,
        threadContext,
      }),
    },
    fetchLike,
  )
})

const updateComment = Effect.fn("azureDevOps.updateComment")(function* (
  context: AzureContext,
  token: Redacted.Redacted<string>,
  threadId: number,
  commentId: number,
  content: string,
  fetchLike: FetchLike = fetch,
) {
  return yield* requestJson(
    `${buildPullRequestUrl(context)}/threads/${threadId}/comments/${commentId}?api-version=7.1`,
    {
      method: "PATCH",
      headers: createHeaders(token),
      body: stringifyJson({
        content,
      }),
    },
    fetchLike,
  )
})

const updateThreadStatus = Effect.fn("azureDevOps.updateThreadStatus")(function* (
  context: AzureContext,
  token: Redacted.Redacted<string>,
  threadId: number,
  status: 1 | 2,
  fetchLike: FetchLike = fetch,
) {
  return yield* requestJson(
    `${buildPullRequestUrl(context)}/threads/${threadId}?api-version=7.1`,
    {
      method: "PATCH",
      headers: createHeaders(token),
      body: stringifyJson({
        status,
      }),
    },
    fetchLike,
  )
})

const requestJson = <T>(url: string, init: RequestInit, fetchLike: FetchLike) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetchLike(url, init)
      const text = await response.text()

      if (!response.ok) {
        throw new AzureDevOpsHttpError({
          message: `Azure DevOps request failed with status ${response.status}.`,
          url,
          status: response.status,
          body: text,
        })
      }

      return text ? parseJsonString<T>(text) : ({} as T)
    },
    catch: (error) => {
      if (error instanceof AzureDevOpsHttpError || (error && typeof error === "object" && "_tag" in error)) {
        return error as AzureDevOpsHttpError
      }

      return new AzureDevOpsHttpError({
        message: "Azure DevOps request failed before a valid response was received.",
        url,
        status: -1,
        body: String(error),
      })
    },
  })

const createHeaders = (token: Redacted.Redacted<string>) => ({
  authorization: `Bearer ${Redacted.value(token)}`,
  "content-type": "application/json",
})

const buildPullRequestUrl = (context: AzureContext) =>
  `${context.collectionUrl.replace(/\/+$/, "")}/${encodeURIComponent(context.project)}/_apis/git/repositories/${encodeURIComponent(
    context.repositoryId,
  )}/pullRequests/${context.pullRequestId}`

const createInlineThreadContext = (finding: ReviewFinding) => ({
  filePath: `/${normalizePath(finding.filePath)}`,
  rightFileStart: { line: finding.line, offset: 1 },
  rightFileEnd: { line: finding.endLine ?? finding.line, offset: 1 },
})

export const buildLinkFromConfig = (config: ReviewConfig) => {
  if (config.buildUri) {
    return config.buildUri
  }

  if (!config.buildId) {
    return undefined
  }

  return `${config.collectionUrl.replace(/\/+$/, "")}/${encodeURIComponent(config.project)}/_build/results?buildId=${encodeURIComponent(config.buildId)}`
}
