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
