import { describe, expect, test } from "bun:test"
import { Effect, Redacted } from "effect"

import { AzureDevOpsClientLive } from "../src/azdo/Layers/AzureDevOpsClient"
import { publishFailureSummary, publishReview } from "../src/azdo/ReviewPublisher"
import { AzureDevOpsClient } from "../src/azdo/Services/AzureDevOpsClient"
import { createAzureContext } from "../src/config/AppConfig"
import { AzureDevOpsHttpError } from "../src/errors"
import {
  createMockFetch,
  type FetchLike,
  makeAppConfig,
  makeAzureDevOpsClient,
  makeAzureDevOpsClientLayer,
  makeFetchMock,
  makeManagedFindingThread,
  makeManagedSummaryThread,
  makeNormalizedReviewResult,
  makeReviewFinding,
} from "./helpers"

const context = createAzureContext(makeAppConfig())
const token = Redacted.make("system-token")

const withFetchMock = async <A>(fetchMock: FetchLike, run: () => Promise<A>) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = createMockFetch(fetchMock, originalFetch)

  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe("azure devops", () => {
  test("creates summary and inline threads for new managed findings", async () => {
    const finding = makeReviewFinding()
    const createThreadCalls: string[] = []

    const result = await Effect.runPromise(
      publishReview({
        context,
        token,
        dryRun: false,
        buildLink: undefined,
        reviewResult: makeNormalizedReviewResult([finding]),
      }).pipe(
        Effect.provide(
          makeAzureDevOpsClientLayer(
            makeAzureDevOpsClient({
              createThread: (input) =>
                Effect.sync(() => {
                  createThreadCalls.push(input.content)
                }),
            }),
          ),
        ),
      ),
    )

    expect(result.actions).toHaveLength(2)
    expect(createThreadCalls).toHaveLength(2)
  })

  test("updates existing summary, reuses matching findings, and closes stale threads", async () => {
    const finding = makeReviewFinding()
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
        buildLink: undefined,
        reviewResult: makeNormalizedReviewResult([finding]),
      }).pipe(
        Effect.provide(
          makeAzureDevOpsClientLayer(
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
        buildLink: undefined,
        reviewResult: makeNormalizedReviewResult([finding]),
      }).pipe(
        Effect.provide(
          makeAzureDevOpsClientLayer(
            makeAzureDevOpsClient({
              createThread: () =>
                Effect.fail(
                  new AzureDevOpsHttpError({
                    message: "boom",
                    url: "https://dev.azure.com/acme/project/_apis/git/repositories/repo-1/pullRequests/42/threads?api-version=7.1",
                    status: 500,
                    body: "boom",
                  }),
                ),
            }),
          ),
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
        failureReason: "Failed badly",
      }).pipe(
        Effect.provide(
          makeAzureDevOpsClientLayer(
            makeAzureDevOpsClient({
              listThreads: () => Effect.succeed([makeManagedSummaryThread()]),
              updateComment: (input) =>
                Effect.sync(() => {
                  updateCommentCalls.push(input.commentId)
                }),
            }),
          ),
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
        buildLink: undefined,
        reviewResult: makeNormalizedReviewResult([finding]),
      }).pipe(
        Effect.provide(
          makeAzureDevOpsClientLayer(
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
      ),
    )

    expect(result.actions.some((action) => action.type === "upsert-summary")).toBe(true)
    expect(createThreadCalls).toHaveLength(1)
  })

  test("decodes pull request metadata from the live client", async () => {
    const { fetchMock } = makeFetchMock(() =>
      Response.json({
        title: "Feature PR",
        description: "Adds a new export",
      }),
    )

    const metadata = await withFetchMock(fetchMock, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* AzureDevOpsClient
          return yield* client.getPullRequestMetadata({ context, token })
        }).pipe(Effect.provide(AzureDevOpsClientLive)),
      ),
    )

    expect(metadata.title).toBe("Feature PR")
  })

  test("fails when the live client receives malformed json", async () => {
    const { fetchMock } = makeFetchMock(() => new Response("{not-json", { status: 200 }))

    const exit = await withFetchMock(fetchMock, () =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          const client = yield* AzureDevOpsClient
          return yield* client.listThreads({ context, token })
        }).pipe(Effect.provide(AzureDevOpsClientLive)),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("fails when the live client receives an unexpected response shape", async () => {
    const { fetchMock } = makeFetchMock(() =>
      Response.json({
        value: [
          {
            id: "wrong-type",
          },
        ],
      }),
    )

    const exit = await withFetchMock(fetchMock, () =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          const client = yield* AzureDevOpsClient
          return yield* client.listThreads({ context, token })
        }).pipe(Effect.provide(AzureDevOpsClientLive)),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })
})
