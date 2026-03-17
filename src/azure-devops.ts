import * as Layer from "effect/Layer"
import * as ServiceMap from "effect/ServiceMap"
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

export type FetchClient = {
  fetch: typeof fetch
}

export const FetchClient = ServiceMap.Service<FetchClient>("open-azdo/FetchClient")
type ManagedSummaryMatch = ReturnType<typeof findManagedSummaryThread> | undefined

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

  return `${config.collectionUrl.replace(/\/+$/, "")}/${encodeURIComponent(config.project)}/_build/results?buildId=${encodeURIComponent(
    config.buildId,
  )}`
}

const makeRequestJson =
  (fetchLike: typeof fetch) =>
  <T>(url: string, init: RequestInit) =>
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

export class AzureDevOpsService extends ServiceMap.Service<
  AzureDevOpsService,
  {
    readonly getPullRequestMetadata: (
      context: AzureContext,
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<PullRequestMetadata, AzureDevOpsHttpError>
    readonly listThreads: (
      context: AzureContext,
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<ExistingThread[], AzureDevOpsHttpError>
    readonly publishReview: (
      config: ReviewConfig,
      reviewResult: NormalizedReviewResult,
    ) => Effect.Effect<{ actions: ThreadAction[]; existingThreads: ExistingThread[] }, AzureDevOpsHttpError>
    readonly publishFailureSummary: (
      config: ReviewConfig,
      failureReason: string,
    ) => Effect.Effect<{ content: string; existingSummary: ManagedSummaryMatch }, AzureDevOpsHttpError>
  }
>()("open-azdo/AzureDevOpsService") {
  static readonly layer = Layer.effect(
    AzureDevOpsService,
    Effect.gen(function* () {
      const fetchClient = yield* FetchClient
      const requestJson = makeRequestJson(fetchClient.fetch)

      const getPullRequestMetadata = Effect.fn("AzureDevOpsService.getPullRequestMetadata")(function* (
        context: AzureContext,
        token: Redacted.Redacted<string>,
      ) {
        return yield* requestJson<PullRequestMetadata>(buildPullRequestUrl(context), {
          method: "GET",
          headers: createHeaders(token),
        })
      })

      const listThreads = Effect.fn("AzureDevOpsService.listThreads")(function* (
        context: AzureContext,
        token: Redacted.Redacted<string>,
      ) {
        const response = yield* requestJson<{ value: ExistingThread[] }>(
          `${buildPullRequestUrl(context)}/threads?api-version=7.1`,
          {
            method: "GET",
            headers: createHeaders(token),
          },
        )

        return response.value ?? []
      })

      const updateThreadStatus = Effect.fn("AzureDevOpsService.updateThreadStatus")(function* (
        context: AzureContext,
        token: Redacted.Redacted<string>,
        threadId: number,
        status: 1 | 2,
      ) {
        return yield* requestJson(`${buildPullRequestUrl(context)}/threads/${threadId}?api-version=7.1`, {
          method: "PATCH",
          headers: createHeaders(token),
          body: stringifyJson({
            status,
          }),
        })
      })

      const updateComment = Effect.fn("AzureDevOpsService.updateComment")(function* (
        context: AzureContext,
        token: Redacted.Redacted<string>,
        threadId: number,
        commentId: number,
        content: string,
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
        )
      })

      const createThread = Effect.fn("AzureDevOpsService.createThread")(function* (
        context: AzureContext,
        token: Redacted.Redacted<string>,
        content: string,
        threadContext: Record<string, unknown> | undefined,
      ) {
        return yield* requestJson(`${buildPullRequestUrl(context)}/threads?api-version=7.1`, {
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
        })
      })

      const upsertThreadComment = Effect.fn("AzureDevOpsService.upsertThreadComment")(function* (
        context: AzureContext,
        token: Redacted.Redacted<string>,
        content: string,
        threadContext: Record<string, unknown> | undefined,
        existingThread: ExistingThread | undefined,
        commentId: number | undefined,
      ) {
        if (!existingThread || !commentId) {
          yield* createThread(context, token, content, threadContext)
          return
        }

        yield* updateComment(context, token, existingThread.id, commentId, content)
        yield* updateThreadStatus(context, token, existingThread.id, 1)
      })

      const applyThreadAction = Effect.fn("AzureDevOpsService.applyThreadAction")(function* (
        context: AzureContext,
        token: Redacted.Redacted<string>,
        action: ThreadAction,
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
            )
            return
          }
          case "close-thread": {
            yield* updateThreadStatus(context, token, action.existingThread.id, 2)
            return
          }
        }
      })

      const publishReview = Effect.fn("AzureDevOpsService.publishReview")(function* (
        config: ReviewConfig,
        reviewResult: NormalizedReviewResult,
      ) {
        const context = createAzureContext(config)
        const existingThreads = yield* listThreads(context, config.systemAccessToken)
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
          yield* applyThreadAction(context, config.systemAccessToken, action)
        }

        return {
          actions,
          existingThreads,
        }
      })

      const publishFailureSummary = Effect.fn("AzureDevOpsService.publishFailureSummary")(function* (
        config: ReviewConfig,
        failureReason: string,
      ) {
        const context = createAzureContext(config)
        const existingThreads = yield* listThreads(context, config.systemAccessToken)
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
        )

        return {
          content,
          existingSummary,
        }
      })

      return AzureDevOpsService.of({
        getPullRequestMetadata,
        listThreads,
        publishReview,
        publishFailureSummary,
      })
    }),
  )
}

export const getPullRequestMetadata = Effect.fn("azureDevOps.getPullRequestMetadata")(function* (
  context: AzureContext,
  token: Redacted.Redacted<string>,
) {
  const azureDevOps = yield* AzureDevOpsService
  return yield* azureDevOps.getPullRequestMetadata(context, token)
})

export const listThreads = Effect.fn("azureDevOps.listThreads")(function* (
  context: AzureContext,
  token: Redacted.Redacted<string>,
) {
  const azureDevOps = yield* AzureDevOpsService
  return yield* azureDevOps.listThreads(context, token)
})

export const publishReview = Effect.fn("azureDevOps.publishReview")(function* (
  config: ReviewConfig,
  reviewResult: NormalizedReviewResult,
) {
  const azureDevOps = yield* AzureDevOpsService
  return yield* azureDevOps.publishReview(config, reviewResult)
})

export const publishFailureSummary = Effect.fn("azureDevOps.publishFailureSummary")(function* (
  config: ReviewConfig,
  failureReason: string,
) {
  const azureDevOps = yield* AzureDevOpsService
  return yield* azureDevOps.publishFailureSummary(config, failureReason)
})
