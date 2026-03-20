import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { AzureDevOpsClient, AzureDevOpsClientLive } from "@open-azdo/azdo/client"
import { createMockFetch, type FetchLike, makeFetchMock, makeAzureContext, systemToken } from "./helpers"

const context = makeAzureContext()
const token = systemToken

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

  test("normalizes missing pull request descriptions to an empty string", async () => {
    const { fetchMock } = makeFetchMock(() =>
      Response.json({
        title: "Feature PR",
        description: null,
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

    expect(metadata.description).toBe("")
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

  test("decodes REST thread payloads with string statuses and nullable fields", async () => {
    const { fetchMock } = makeFetchMock(() =>
      Response.json({
        value: [
          {
            id: 123,
            status: "active",
            comments: [
              {
                id: 456,
                content: null,
              },
            ],
            threadContext: {
              filePath: "/src/example.ts",
              rightFileStart: {
                line: 10,
                offset: null,
              },
              rightFileEnd: {
                line: 12,
                offset: null,
              },
            },
          },
        ],
      }),
    )

    const threads = await withFetchMock(fetchMock, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* AzureDevOpsClient
          return yield* client.listThreads({ context, token })
        }).pipe(Effect.provide(AzureDevOpsClientLive)),
      ),
    )

    expect(threads).toHaveLength(1)
    expect(threads[0]?.status).toBe("active")
    expect(threads[0]?.comments[0]?.content).toBeNull()
  })

  test("decodes system threads without status and with null thread context", async () => {
    const { fetchMock } = makeFetchMock(() =>
      Response.json({
        value: [
          {
            id: 42833,
            comments: [
              {
                id: 1,
                content: "Policy status has been updated",
              },
            ],
            threadContext: null,
          },
        ],
      }),
    )

    const threads = await withFetchMock(fetchMock, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* AzureDevOpsClient
          return yield* client.listThreads({ context, token })
        }).pipe(Effect.provide(AzureDevOpsClientLive)),
      ),
    )

    expect(threads).toHaveLength(1)
    expect(threads[0]?.status).toBeUndefined()
    expect(threads[0]?.threadContext).toBeNull()
  })
})
