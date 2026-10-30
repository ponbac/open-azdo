import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import {
  AzureDevOpsClient,
  AzureDevOpsHttpError,
  type CreateThreadInput,
  type UpdateCommentInput,
  type UpdateThreadStatusInput,
} from "@open-azdo/azdo/client"
import { publishFailureSummary, publishReview } from "../src/review/ReviewPublisher"
import { buildSummaryComment, decodeManagedThreads } from "../src/review/ThreadReconciliation"

import {
  BOT_ID,
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
    const finding = makeReviewFinding({ filePath: "back\\slash.ts" })
    const createThreadCalls: string[] = []
    const inlinePaths: string[] = []

    const result = await Effect.runPromise(
      publishReview({
        authenticatedIdentity: BOT_ID,
        context,
        token,
        dryRun: false,
        summaryContent,
        summaryVerdict: "concerns",
        inlineFindings: [finding],
        resolvedManagedFindingIds: [],
        reviewMode: "full",
        scopedChangedLinesByFile: new Map([[finding.filePath, new Set([finding.line])]]),
        scopedDeletedLinesByFile,
      }).pipe(
        Effect.provideService(
          AzureDevOpsClient,
          makeAzureDevOpsClient({
            createThread: (input) =>
              Effect.sync(() => {
                createThreadCalls.push(input.content)

                if (input.threadContext?.filePath) inlinePaths.push(input.threadContext.filePath)
              }),
          }),
        ),
      ),
    )

    expect(result.actions).toHaveLength(2)
    expect(createThreadCalls).toHaveLength(2)
    expect(inlinePaths).toEqual(["/back\\slash.ts"])
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
        authenticatedIdentity: BOT_ID,
        context,
        token,
        dryRun: false,
        summaryContent,
        summaryVerdict: "concerns",
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

    expect(result.actions.map((action) => action.type)).toEqual(["upsert-finding", "close-thread", "upsert-summary"])
    expect(updateCommentCalls).toEqual([20, 10])
    expect(updateStatusCalls).toEqual([2, 3, 1])
  })

  test.each([1, 2])("resolves the summary and any active failure notice (failure status %i)", async (failureStatus) => {
    const updateStatusCalls: Array<{ threadId: number; status: number }> = []

    await Effect.runPromise(
      publishReview({
        authenticatedIdentity: BOT_ID,
        context,
        token,
        dryRun: false,
        summaryContent,
        summaryVerdict: "pass",
        inlineFindings: [],
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
                makeManagedSummaryThread(),
                {
                  id: 8,
                  status: failureStatus,
                  comments: [
                    {
                      id: 80,
                      author: { id: BOT_ID },
                      content: 'Failed\n<!-- open-azdo-failure:{"kind":"failure"} -->',
                    },
                  ],
                },
              ]),
            updateThreadStatus: (input) =>
              Effect.sync(() => {
                updateStatusCalls.push({ threadId: input.threadId, status: input.status })
              }),
          }),
        ),
      ),
    )

    expect(updateStatusCalls).toEqual(
      failureStatus === 1
        ? [
            { threadId: 8, status: 2 },
            { threadId: 1, status: 2 },
          ]
        : [{ threadId: 1, status: 2 }],
    )
  })

  test("surfaces comment post failures", async () => {
    const finding = makeReviewFinding()

    const exit = await Effect.runPromiseExit(
      publishReview({
        authenticatedIdentity: BOT_ID,
        context,
        token,
        dryRun: false,
        summaryContent,
        summaryVerdict: "concerns",
        inlineFindings: [finding],
        resolvedManagedFindingIds: [],
        reviewMode: "full",
        scopedChangedLinesByFile,
        scopedDeletedLinesByFile,
      }).pipe(
        Effect.provideService(
          AzureDevOpsClient,
          makeAzureDevOpsClient({
            createThread: () =>
              Effect.fail(
                new AzureDevOpsHttpError({
                  message: "boom",
                  url: "https://dev.azure.com/acme/project/_apis/git/repositories/repo-1/pullRequests/42/threads",
                  status: 500,
                  body: "",
                }),
              ),
          }),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("publishes failure separately without overwriting or copying the committed checkpoint", async () => {
    const createThreadCalls: CreateThreadInput[] = []
    const updateCommentCalls: UpdateCommentInput[] = []
    const updateStatusCalls: UpdateThreadStatusInput[] = []

    await Effect.runPromise(
      publishFailureSummary({
        context,
        token,
        dryRun: false,
        buildLink: undefined,
        managedThreads: decodeManagedThreads(
          [
            makeManagedSummaryThread(
              makeManagedReviewState({
                reviewedCommit: "preserved-sha",
              }),
            ),
          ],
          BOT_ID,
        ),
        failureReason: "Failed badly",
      }).pipe(
        Effect.provideService(
          AzureDevOpsClient,
          makeAzureDevOpsClient({
            createThread: (input) =>
              Effect.sync(() => {
                createThreadCalls.push(input)
              }),
            updateComment: (input) =>
              Effect.sync(() => {
                updateCommentCalls.push(input)
              }),
            updateThreadStatus: (input) =>
              Effect.sync(() => {
                updateStatusCalls.push(input)
              }),
          }),
        ),
      ),
    )

    expect(updateCommentCalls).toEqual([])
    expect(updateStatusCalls).toEqual([])
    expect(createThreadCalls).toHaveLength(1)
    expect(createThreadCalls[0]?.status).toBe(1)

    const content = createThreadCalls[0]?.content ?? ""

    expect(content).toContain("Verdict: **fail**")
    expect(content).toContain("Review execution failed.\n\nFailed badly")
    expect(content).toContain('<!-- open-azdo-failure:{"kind":"failure"} -->')
    expect(content).not.toContain("reviewedCommit")
  })

  test("ignores existing thread comments without string content", async () => {
    const finding = makeReviewFinding()
    const createThreadCalls: string[] = []

    const result = await Effect.runPromise(
      publishReview({
        authenticatedIdentity: BOT_ID,
        context,
        token,
        dryRun: false,
        summaryContent,
        summaryVerdict: "concerns",
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
})
