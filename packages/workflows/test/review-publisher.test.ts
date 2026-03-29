import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { AzureDevOpsClient } from "@open-azdo/azdo/client"
import { publishFailureSummary, publishReview } from "../src/review/ReviewPublisher"
import { buildSummaryComment } from "../src/review/ThreadReconciliation"

import {
  makeAzureContext,
  makeAzureDevOpsClient,
  makeManagedReviewState,
  makeManagedFindingThread,
  makeManagedSummaryThread,
  makeReviewFinding,
  makeSummarySnapshot,
  systemToken,
} from "./helpers"

const context = makeAzureContext()
const token = systemToken
const scopedChangedLinesByFile = new Map([["src/example.ts", new Set([2, 3])]])
const scopedDeletedLinesByFile = new Map<string, Set<number>>()
const summaryContent = buildSummaryComment(makeSummarySnapshot())

describe("review publisher", () => {
  test("creates summary and inline threads for new managed findings", async () => {
    const finding = makeReviewFinding()
    const createThreadCalls: string[] = []

    const result = await Effect.runPromise(
      publishReview({
        context,
        token,
        dryRun: false,
        summaryContent,
        inlineFindings: [finding],
        resolvedManagedFindingIds: [],
        reviewMode: "full",
        scopedChangedLinesByFile,
        scopedDeletedLinesByFile,
      }).pipe(
        Effect.provideService(
          AzureDevOpsClient,
          makeAzureDevOpsClient({
            createThread: (input) =>
              Effect.sync(() => {
                createThreadCalls.push(input.content)
              }),
          }),
        ),
      ),
    )

    expect(result.actions).toHaveLength(2)
    expect(createThreadCalls).toHaveLength(2)
  })

  test("updates existing summary, reuses linked findings, and closes only explicitly resolved threads", async () => {
    const finding = makeReviewFinding({
      managedFindingId: 2,
    })
    const staleFinding = makeReviewFinding({
      title: "Stale finding",
      line: 3,
    })
    const updateCommentCalls: number[] = []
    const updateStatusCalls: number[] = []

    const result = await Effect.runPromise(
      publishReview({
        context,
        token,
        dryRun: false,
        summaryContent,
        inlineFindings: [finding],
        resolvedManagedFindingIds: [3],
        reviewMode: "full",
        scopedChangedLinesByFile,
        scopedDeletedLinesByFile,
      }).pipe(
        Effect.provideService(
          AzureDevOpsClient,
          makeAzureDevOpsClient({
            listThreads: () =>
              Effect.succeed([
                makeManagedSummaryThread(),
                makeManagedFindingThread(finding, 2),
                makeManagedFindingThread(staleFinding, 3),
              ]),
            updateComment: (input) =>
              Effect.sync(() => {
                updateCommentCalls.push(input.commentId)
              }),
            updateThreadStatus: (input) =>
              Effect.sync(() => {
                updateStatusCalls.push(input.threadId)
              }),
          }),
        ),
      ),
    )

    expect(result.actions.map((action) => action.type)).toEqual(["upsert-summary", "upsert-finding", "close-thread"])
    expect(updateCommentCalls).toEqual([10, 20])
    expect(updateStatusCalls).toEqual([1, 2, 3])
  })

  test("surfaces comment post failures", async () => {
    const finding = makeReviewFinding()

    const exit = await Effect.runPromiseExit(
      publishReview({
        context,
        token,
        dryRun: false,
        summaryContent,
        inlineFindings: [finding],
        resolvedManagedFindingIds: [],
        reviewMode: "full",
        scopedChangedLinesByFile,
        scopedDeletedLinesByFile,
      }).pipe(
        Effect.provideService(
          AzureDevOpsClient,
          makeAzureDevOpsClient({
            createThread: () => Effect.fail(new Error("boom") as never),
          }),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("publishes a managed failure summary", async () => {
    const updateCommentCalls: number[] = []

    await Effect.runPromise(
      publishFailureSummary({
        context,
        token,
        dryRun: false,
        buildLink: undefined,
        existingThreads: [makeManagedSummaryThread()],
        failureReason: "Failed badly",
        preservedSummaryState: makeManagedReviewState({
          reviewedCommit: "preserved-sha",
        }),
      }).pipe(
        Effect.provideService(
          AzureDevOpsClient,
          makeAzureDevOpsClient({
            updateComment: (input) =>
              Effect.sync(() => {
                updateCommentCalls.push(input.commentId)
              }),
          }),
        ),
      ),
    )

    expect(updateCommentCalls).toEqual([10])
  })

  test("ignores existing thread comments without string content", async () => {
    const finding = makeReviewFinding()
    const createThreadCalls: string[] = []

    const result = await Effect.runPromise(
      publishReview({
        context,
        token,
        dryRun: false,
        summaryContent,
        inlineFindings: [finding],
        resolvedManagedFindingIds: [],
        reviewMode: "full",
        scopedChangedLinesByFile,
        scopedDeletedLinesByFile,
      }).pipe(
        Effect.provideService(
          AzureDevOpsClient,
          makeAzureDevOpsClient({
            listThreads: () =>
              Effect.succeed([
                {
                  id: 99,
                  status: 1,
                  comments: [
                    {
                      id: 999,
                    },
                  ],
                },
                makeManagedSummaryThread(),
              ]),
            createThread: (input) =>
              Effect.sync(() => {
                createThreadCalls.push(input.content)
              }),
          }),
        ),
      ),
    )

    expect(result.actions.some((action) => action.type === "upsert-summary")).toBe(true)
    expect(createThreadCalls).toHaveLength(1)
  })

  test("skipped mode only updates the managed summary thread", async () => {
    const updateCommentCalls: number[] = []
    const result = await Effect.runPromise(
      publishReview({
        context,
        token,
        dryRun: false,
        summaryContent,
        inlineFindings: [],
        resolvedManagedFindingIds: [],
        reviewMode: "skipped",
        scopedChangedLinesByFile,
        scopedDeletedLinesByFile,
      }).pipe(
        Effect.provideService(
          AzureDevOpsClient,
          makeAzureDevOpsClient({
            listThreads: () =>
              Effect.succeed([makeManagedSummaryThread(), makeManagedFindingThread(makeReviewFinding(), 2)]),
            updateComment: (input) =>
              Effect.sync(() => {
                updateCommentCalls.push(input.commentId)
              }),
          }),
        ),
      ),
    )

    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]?.type).toBe("upsert-summary")
    expect(updateCommentCalls).toEqual([10])
  })
})
