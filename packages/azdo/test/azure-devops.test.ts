import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Result } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

import { AzureDevOpsClient, AzureDevOpsClientLive } from "@open-azdo/azdo/client"
import { type FetchLike, makeFetchMock, makeAzureContext, systemToken } from "./helpers"

const context = makeAzureContext()
const token = systemToken

const parseJsonBody = (body: BodyInit | null | undefined) => {
  if (typeof body === "string") {
    return JSON.parse(body)
  }

  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body))
  }

  return {}
}

const isTitleOnlyBatchRequest = (body: { readonly fields?: ReadonlyArray<string> | undefined }) =>
  Array.isArray(body.fields) && body.fields.includes("System.Title") && body.fields.length === 1

const isWorkItemCommentsUrl = (url: string) => {
  const parsed = new URL(url)
  return (
    parsed.pathname === "/acme/project/_apis/wit/workItems/123/comments" &&
    parsed.searchParams.get("$top") === "20" &&
    parsed.searchParams.get("order") === "desc" &&
    parsed.searchParams.get("$expand") === "renderedText" &&
    parsed.searchParams.get("api-version") === "7.1-preview.4"
  )
}

const provideLiveClient =
  (fetchMock: FetchLike) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetchMock as typeof globalThis.fetch),
      Effect.provide(Layer.fresh(AzureDevOpsClientLive)),
    )

describe("azure devops", () => {
  test("decodes pull request metadata from the live client", async () => {
    const { fetchMock } = makeFetchMock(() =>
      Response.json({
        pullRequestId: 42,
        title: "Feature PR",
        description: "Adds a new export",
        sourceRefName: "refs/heads/feature",
        targetRefName: "refs/heads/main",
        createdBy: {
          displayName: "Annie Case",
        },
        repository: {
          id: "repo-1",
          name: "open-azdo",
          remoteUrl: "https://dev.azure.com/acme/project/_git/repo-1",
          webUrl: "https://dev.azure.com/acme/project/_git/repo-1",
        },
        lastMergeSourceCommit: {
          commitId: "abc123",
        },
        workItemRefs: [
          {
            id: "123",
            url: "https://dev.azure.com/acme/project/_apis/wit/workItems/123",
          },
        ],
      }),
    )

    const metadata = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.getPullRequestMetadata({ context, token })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(metadata.title).toBe("Feature PR")
    expect(metadata.pullRequestId).toBe(42)
    expect(metadata.sourceRefName).toBe("refs/heads/feature")
    expect(metadata.targetRefName).toBe("refs/heads/main")
    expect(metadata.createdByDisplayName).toBe("Annie Case")
    expect(metadata.repository?.name).toBe("open-azdo")
    expect(metadata.sourceCommitId).toBe("abc123")
    expect(metadata.workItemRefs).toEqual([
      {
        id: "123",
        url: "https://dev.azure.com/acme/project/_apis/wit/workItems/123",
      },
    ])
  })

  test("normalizes missing pull request descriptions to an empty string", async () => {
    const { fetchMock } = makeFetchMock(() =>
      Response.json({
        title: "Feature PR",
        description: null,
        workItemRefs: [],
      }),
    )

    const metadata = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.getPullRequestMetadata({ context, token })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(metadata.description).toBe("")
    expect(metadata.workItemRefs).toEqual([])
  })

  test("falls back to the dedicated pull request work-items endpoint when metadata omits workItemRefs", async () => {
    const requestedUrls: string[] = []

    const { fetchMock } = makeFetchMock((url) => {
      requestedUrls.push(url)

      if (url.includes("/pullRequests/42?")) {
        return Response.json({
          title: "Feature PR",
          description: "Adds a new export",
        })
      }

      if (url.includes("/pullRequests/42/workitems?api-version=7.1-preview.1")) {
        return Response.json([
          {
            id: "123",
            url: "https://dev.azure.com/acme/project/_apis/wit/workItems/123",
          },
        ])
      }

      return Response.json({})
    })

    const metadata = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.getPullRequestMetadata({ context, token })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(requestedUrls).toEqual([
      "https://dev.azure.com/acme/project/_apis/git/repositories/repo-1/pullRequests/42?includeWorkItemRefs=true&api-version=7.1",
      "https://dev.azure.com/acme/project/_apis/git/repositories/repo-1/pullRequests/42/workitems?api-version=7.1-preview.1",
    ])
    expect(metadata.workItemRefs).toEqual([
      {
        id: "123",
        url: "https://dev.azure.com/acme/project/_apis/wit/workItems/123",
      },
    ])
  })

  test("fails when the live client receives malformed json", async () => {
    const { fetchMock } = makeFetchMock(() => new Response("{not-json", { status: 200 }))

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.listThreads({ context, token })
      }).pipe(provideLiveClient(fetchMock)),
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

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.listThreads({ context, token })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("maps non-2xx responses to AzureDevOpsHttpError", async () => {
    const { fetchMock } = makeFetchMock(() => Response.json({ message: "Nope" }, { status: 503 }))

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.listThreads({ context, token })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const found = Cause.findError(exit.cause)
      expect(Result.isFailure(found)).toBe(false)
      if (!Result.isFailure(found)) {
        expect(found.success._tag).toBe("AzureDevOpsHttpError")
        if (found.success._tag === "AzureDevOpsHttpError") {
          expect(found.success.status).toBe(503)
        }
      }
    }
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
                publishedDate: "2026-03-22T09:00:00.000Z",
                isDeleted: false,
                commentType: 1,
                author: {
                  displayName: "Annie Case",
                },
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

    const threads = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.listThreads({ context, token })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(threads).toHaveLength(1)
    expect(threads[0]?.status).toBe("active")
    expect(threads[0]?.comments[0]?.content).toBeNull()
    expect(threads[0]?.comments[0]?.author?.displayName).toBe("Annie Case")
    expect(threads[0]?.comments[0]?.publishedDate).toBe("2026-03-22T09:00:00.000Z")
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

    const threads = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.listThreads({ context, token })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(threads).toHaveLength(1)
    expect(threads[0]?.status).toBeUndefined()
    expect(threads[0]?.threadContext).toBeNull()
  })

  test("fetches connected work items with related titles and markdown comments", async () => {
    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        const body = parseJsonBody(init.body)

        if (isTitleOnlyBatchRequest(body)) {
          return Response.json({
            value: [
              {
                id: 456,
                fields: {
                  "System.Title": "Parent title",
                },
              },
              {
                id: 789,
                fields: {
                  "System.Title": "Related title",
                },
              },
            ],
          })
        }

        return Response.json({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Fix regression",
                "System.WorkItemType": "Bug",
                "System.State": "Active",
                "Microsoft.VSTS.Common.Priority": 1,
                "System.AssignedTo": {
                  displayName: "Jane Doe",
                },
                "System.Description": '<p>Hello <a href="https://example.com">world</a></p>',
                "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>Do the thing</li></ul>",
                "Microsoft.VSTS.TCM.ReproSteps": "<p>Step 1</p>",
                "System.IterationPath": "project\\Sprint 1",
                "System.AreaPath": "project\\Area",
                "System.Tags": "one; two",
              },
              relations: [
                {
                  rel: "System.LinkTypes.Hierarchy-Reverse",
                  url: "https://dev.azure.com/acme/project/_apis/wit/workItems/456",
                },
                {
                  rel: "System.LinkTypes.Related",
                  url: "https://dev.azure.com/acme/project/_apis/wit/workItems/789",
                },
              ],
            },
          ],
        })
      }

      if (isWorkItemCommentsUrl(url)) {
        return Response.json({
          comments: [
            {
              text: "fallback text",
              renderedText: "<p>Rendered comment</p>",
              createdDate: "2026-03-21T10:00:00.000Z",
              isDeleted: false,
              createdBy: {
                displayName: "Reviewer",
              },
            },
            {
              text: "deleted",
              createdDate: "2026-03-21T09:00:00.000Z",
              isDeleted: true,
              createdBy: {
                displayName: "Old Reviewer",
              },
            },
          ],
        })
      }

      return Response.json({})
    })

    const workItems = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.getPullRequestWorkItems({
          context,
          token,
          workItemRefs: [{ id: "123" }],
        })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(workItems).toEqual([
      {
        id: 123,
        title: "Fix regression",
        workItemType: "Bug",
        state: "Active",
        priority: 1,
        assignedTo: "Jane Doe",
        iterationPath: "project\\Sprint 1",
        areaPath: "project\\Area",
        tags: ["one", "two"],
        descriptionMarkdown: "Hello world",
        acceptanceCriteriaMarkdown: "-   Do the thing",
        reproStepsMarkdown: "Step 1",
        parent: {
          id: 456,
          title: "Parent title",
        },
        related: [
          {
            id: 789,
            title: "Related title",
          },
        ],
        recentComments: [
          {
            author: "Reviewer",
            createdAt: "2026-03-21T10:00:00.000Z",
            markdown: "Rendered comment",
          },
        ],
      },
    ])
  })

  test("backfills later work items when earlier refs are omitted from the batch response", async () => {
    const commentIds: number[] = []

    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        const body = parseJsonBody(init.body)

        if (isTitleOnlyBatchRequest(body)) {
          return Response.json({ value: [] })
        }

        return Response.json({
          value: [101, 103, 104, 105].map((id) => ({
            id,
            fields: {
              "System.Title": `Work item ${id}`,
              "System.WorkItemType": "Task",
              "System.State": "Active",
            },
          })),
        })
      }

      const commentMatch = url.match(/\/_apis\/wit\/workItems\/(\d+)\/comments\?/)

      if (commentMatch) {
        commentIds.push(Number.parseInt(commentMatch[1] ?? "", 10))
        return Response.json({ comments: [] })
      }

      return Response.json({})
    })

    const workItems = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.getPullRequestWorkItems({
          context,
          token,
          workItemRefs: [{ id: "101" }, { id: "102" }, { id: "103" }, { id: "104" }, { id: "105" }],
        })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(workItems.map((workItem) => workItem.id)).toEqual([101, 103, 104, 105])
    expect(commentIds).toEqual([101, 103, 104, 105])
  })

  test("keeps cross-project work item requests on the pull request project endpoint", async () => {
    const batchUrls: string[] = []
    const commentUrls: string[] = []

    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        batchUrls.push(url)
        const body = parseJsonBody(init.body)

        if (isTitleOnlyBatchRequest(body)) {
          return Response.json({
            value: [
              {
                id: 456,
                fields: {
                  "System.Title": "Cross-project parent",
                },
              },
            ],
          })
        }

        return Response.json({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Cross-project bug",
                "System.WorkItemType": "Bug",
                "System.State": "Active",
              },
              relations: [
                {
                  rel: "System.LinkTypes.Hierarchy-Reverse",
                  url: "https://dev.azure.com/acme/other-project/_apis/wit/workItems/456",
                },
              ],
            },
          ],
        })
      }

      if (url.includes("/_apis/wit/workItems/123/comments?")) {
        commentUrls.push(url)
        return Response.json({
          comments: [
            {
              text: "Cross-project comment",
              createdDate: "2026-03-21T10:00:00.000Z",
              isDeleted: false,
              createdBy: {
                displayName: "Reviewer",
              },
            },
          ],
        })
      }

      return Response.json({})
    })

    const workItems = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.getPullRequestWorkItems({
          context,
          token,
          workItemRefs: [{ id: "123", url: "https://dev.azure.com/acme/other-project/_apis/wit/workItems/123" }],
        })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(batchUrls).toEqual([
      "https://dev.azure.com/acme/project/_apis/wit/workitemsbatch?api-version=7.1",
      "https://dev.azure.com/acme/project/_apis/wit/workitemsbatch?api-version=7.1",
    ])
    expect(commentUrls).toEqual([
      "https://dev.azure.com/acme/project/_apis/wit/workItems/123/comments?%24top=20&order=desc&%24expand=renderedText&api-version=7.1-preview.4",
    ])
    expect(workItems[0]?.parent).toEqual({
      id: 456,
      title: "Cross-project parent",
    })
  })

  test("only fetches enough linked work items to fill the prompt slots", async () => {
    const selectedBatchRequests: number[][] = []
    const commentIds: number[] = []

    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        const body = parseJsonBody(init.body)

        if (isTitleOnlyBatchRequest(body)) {
          return Response.json({ value: [] })
        }

        selectedBatchRequests.push(body.ids)

        return Response.json({
          value: body.ids.map((id: number) => ({
            id,
            fields: {
              "System.Title": `Work item ${id}`,
              "System.WorkItemType": "Task",
              "System.State": "Active",
            },
          })),
        })
      }

      const commentMatch = url.match(/\/_apis\/wit\/workItems\/(\d+)\/comments\?/)

      if (commentMatch) {
        commentIds.push(Number.parseInt(commentMatch[1] ?? "", 10))
        return Response.json({ comments: [] })
      }

      return Response.json({})
    })

    const workItems = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.getPullRequestWorkItems({
          context,
          token,
          workItemRefs: Array.from({ length: 10 }, (_, index) => ({ id: String(index + 1) })),
        })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(selectedBatchRequests).toEqual([[1, 2, 3, 4]])
    expect(workItems.map((workItem) => workItem.id)).toEqual([1, 2, 3, 4])
    expect(commentIds).toEqual([1, 2, 3, 4])
  })

  test("preserves markdown-only work item comments when rendered html is unavailable", async () => {
    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        const body = parseJsonBody(init.body)

        if (isTitleOnlyBatchRequest(body)) {
          return Response.json({ value: [] })
        }

        return Response.json({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Fix regression",
                "System.WorkItemType": "Bug",
                "System.State": "Active",
              },
            },
          ],
        })
      }

      if (isWorkItemCommentsUrl(url)) {
        return Response.json({
          comments: [
            {
              text: "See [details](https://example.com)\r\n\r\n\r\n- one\r\n- two",
              createdDate: "2026-03-21T10:00:00.000Z",
              isDeleted: false,
              createdBy: {
                displayName: "Reviewer",
              },
            },
          ],
        })
      }

      return Response.json({})
    })

    const workItems = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.getPullRequestWorkItems({
          context,
          token,
          workItemRefs: [{ id: "123" }],
        })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(workItems[0]?.recentComments).toEqual([
      {
        author: "Reviewer",
        createdAt: "2026-03-21T10:00:00.000Z",
        markdown: "See [details](https://example.com)\n\n- one\n- two",
      },
    ])
  })

  test("only resolves titles that can reach the prompt and filters irrelevant relation types", async () => {
    const titleBatchRequests: number[][] = []

    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        const body = parseJsonBody(init.body)

        if (isTitleOnlyBatchRequest(body)) {
          titleBatchRequests.push(body.ids)

          return Response.json({
            value: body.ids.map((id: number) => ({
              id,
              fields: {
                "System.Title": `Title ${id}`,
              },
            })),
          })
        }

        return Response.json({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Fix regression",
                "System.WorkItemType": "Bug",
                "System.State": "Active",
              },
              relations: [
                {
                  rel: "System.LinkTypes.Hierarchy-Reverse",
                  url: "https://dev.azure.com/acme/project/_apis/wit/workItems/999",
                },
                {
                  rel: "System.LinkTypes.Related",
                  url: "https://dev.azure.com/acme/project/_apis/wit/workItems/1000",
                },
                ...Array.from({ length: 250 }, (_, index) => ({
                  rel: "System.LinkTypes.Dependency-Forward",
                  url: `https://dev.azure.com/acme/project/_apis/wit/workItems/${2_000 + index}`,
                })),
                ...Array.from({ length: 205 }, (_, index) => ({
                  rel: "System.LinkTypes.Related",
                  url: `https://dev.azure.com/acme/project/_apis/wit/workItems/${3_000 + index}`,
                })),
              ],
            },
          ],
        })
      }

      if (isWorkItemCommentsUrl(url)) {
        return Response.json({ comments: [] })
      }

      return Response.json({})
    })

    const workItems = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.getPullRequestWorkItems({
          context,
          token,
          workItemRefs: [{ id: "123" }],
        })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(titleBatchRequests).toEqual([[999, 1000, 3_000, 3_001, 3_002]])
    expect(workItems[0]?.parent).toEqual({
      id: 999,
      title: "Title 999",
    })
    expect(workItems[0]?.related).toHaveLength(206)
    expect(workItems[0]?.related.slice(0, 5)).toEqual([
      { id: 1000, title: "Title 1000" },
      { id: 3_000, title: "Title 3000" },
      { id: 3_001, title: "Title 3001" },
      { id: 3_002, title: "Title 3002" },
      { id: 3_003 },
    ])
  })

  test("accepts organization-scoped relation urls when extracting relation titles", async () => {
    const titleBatchRequests: number[][] = []

    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        const body = parseJsonBody(init.body)

        if (isTitleOnlyBatchRequest(body)) {
          titleBatchRequests.push(body.ids)

          return Response.json({
            value: [
              {
                id: 456,
                fields: {
                  "System.Title": "Parent title",
                },
              },
            ],
          })
        }

        return Response.json({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Fix regression",
                "System.WorkItemType": "Bug",
                "System.State": "Active",
              },
              relations: [
                {
                  rel: "System.LinkTypes.Hierarchy-Reverse",
                  url: "https://dev.azure.com/acme/_apis/wit/workItems/456",
                  attributes: {
                    id: 999_999,
                  },
                },
              ],
            },
          ],
        })
      }

      if (isWorkItemCommentsUrl(url)) {
        return Response.json({ comments: [] })
      }

      return Response.json({})
    })

    const workItems = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.getPullRequestWorkItems({
          context,
          token,
          workItemRefs: [{ id: "123" }],
        })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(titleBatchRequests).toEqual([[456]])
    expect(workItems[0]?.parent).toEqual({
      id: 456,
      title: "Parent title",
    })
  })

  test("omits field filters when expanding connected work item relations", async () => {
    const batchBodies: Array<Record<string, unknown>> = []

    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        const body = parseJsonBody(init.body)
        batchBodies.push(body)

        if (isTitleOnlyBatchRequest(body)) {
          return Response.json({ value: [] })
        }

        return Response.json({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Fix regression",
                "System.WorkItemType": "Bug",
                "System.State": "Active",
              },
              relations: [
                {
                  rel: "System.LinkTypes.Hierarchy-Reverse",
                  url: "https://dev.azure.com/acme/project/_apis/wit/workItems/456",
                },
              ],
            },
          ],
        })
      }

      if (isWorkItemCommentsUrl(url)) {
        return Response.json({ comments: [] })
      }

      return Response.json({})
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* AzureDevOpsClient
        return yield* client.getPullRequestWorkItems({
          context,
          token,
          workItemRefs: [{ id: "123" }],
        })
      }).pipe(provideLiveClient(fetchMock)),
    )

    expect(batchBodies).toHaveLength(2)
    expect(batchBodies[0]).toMatchObject({
      ids: [123],
      errorPolicy: "omit",
      $expand: "Relations",
    })
    expect(batchBodies[0]?.fields).toBeUndefined()
    expect(batchBodies[1]).toMatchObject({
      ids: [456],
      fields: ["System.Title"],
      errorPolicy: "omit",
    })
  })
})
