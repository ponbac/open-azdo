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

const parseJsonBody = (body: BodyInit | null | undefined) => JSON.parse(typeof body === "string" ? body : "{}")

describe("azure devops", () => {
  test("decodes pull request metadata from the live client", async () => {
    const { fetchMock } = makeFetchMock(() =>
      Response.json({
        title: "Feature PR",
        description: "Adds a new export",
        workItemRefs: [
          {
            id: "123",
            url: "https://dev.azure.com/acme/project/_apis/wit/workItems/123",
          },
        ],
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
    expect(metadata.workItemRefs).toEqual([])
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

  test("fetches connected work items with related titles and markdown comments", async () => {
    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        const body = parseJsonBody(init.body)

        if (body.fields.includes("System.Title") && body.fields.length === 1) {
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

      if (url.endsWith("/_apis/wit/workItems/123/comments?$top=20&$expand=renderedText&api-version=7.1-preview.4")) {
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

    const workItems = await withFetchMock(fetchMock, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* AzureDevOpsClient
          return yield* client.getPullRequestWorkItems({
            context,
            token,
            workItemRefs: [{ id: "123" }],
          })
        }).pipe(Effect.provide(AzureDevOpsClientLive)),
      ),
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

  test("keeps cross-project work item requests on the pull request project endpoint", async () => {
    const batchUrls: string[] = []
    const commentUrls: string[] = []

    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        batchUrls.push(url)
        const body = parseJsonBody(init.body)

        if (body.fields.includes("System.Title") && body.fields.length === 1) {
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

    const workItems = await withFetchMock(fetchMock, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* AzureDevOpsClient
          return yield* client.getPullRequestWorkItems({
            context,
            token,
            workItemRefs: [{ id: "123", url: "https://dev.azure.com/acme/other-project/_apis/wit/workItems/123" }],
          })
        }).pipe(Effect.provide(AzureDevOpsClientLive)),
      ),
    )

    expect(batchUrls).toEqual([
      "https://dev.azure.com/acme/project/_apis/wit/workitemsbatch?api-version=7.1",
      "https://dev.azure.com/acme/project/_apis/wit/workitemsbatch?api-version=7.1",
    ])
    expect(commentUrls).toEqual([
      "https://dev.azure.com/acme/project/_apis/wit/workItems/123/comments?$top=20&$expand=renderedText&api-version=7.1-preview.4",
    ])
    expect(workItems[0]?.parent).toEqual({
      id: 456,
      title: "Cross-project parent",
    })
  })

  test("preserves markdown-only work item comments when rendered html is unavailable", async () => {
    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        const body = parseJsonBody(init.body)

        if (body.fields.includes("System.Title") && body.fields.length === 1) {
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

      if (url.endsWith("/_apis/wit/workItems/123/comments?$top=20&$expand=renderedText&api-version=7.1-preview.4")) {
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

    const workItems = await withFetchMock(fetchMock, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* AzureDevOpsClient
          return yield* client.getPullRequestWorkItems({
            context,
            token,
            workItemRefs: [{ id: "123" }],
          })
        }).pipe(Effect.provide(AzureDevOpsClientLive)),
      ),
    )

    expect(workItems[0]?.recentComments).toEqual([
      {
        author: "Reviewer",
        createdAt: "2026-03-21T10:00:00.000Z",
        markdown: "See [details](https://example.com)\n\n- one\n- two",
      },
    ])
  })

  test("filters irrelevant relation types and chunks title lookups to Azure DevOps batch limits", async () => {
    const titleBatchRequests: number[][] = []

    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        const body = parseJsonBody(init.body)

        if (body.fields.includes("System.Title") && body.fields.length === 1) {
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

      if (url.endsWith("/_apis/wit/workItems/123/comments?$top=20&$expand=renderedText&api-version=7.1-preview.4")) {
        return Response.json({ comments: [] })
      }

      return Response.json({})
    })

    const workItems = await withFetchMock(fetchMock, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* AzureDevOpsClient
          return yield* client.getPullRequestWorkItems({
            context,
            token,
            workItemRefs: [{ id: "123" }],
          })
        }).pipe(Effect.provide(AzureDevOpsClientLive)),
      ),
    )

    expect(titleBatchRequests).toEqual([[999, 1000, 3000, 3001, 3002]])
    expect(workItems[0]?.parent).toEqual({
      id: 999,
      title: "Title 999",
    })
    expect(workItems[0]?.related).toHaveLength(206)
  })

  test("accepts organization-scoped relation urls when extracting relation titles", async () => {
    const titleBatchRequests: number[][] = []

    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
        const body = parseJsonBody(init.body)

        if (body.fields.includes("System.Title") && body.fields.length === 1) {
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

      if (url.endsWith("/_apis/wit/workItems/123/comments?$top=20&$expand=renderedText&api-version=7.1-preview.4")) {
        return Response.json({ comments: [] })
      }

      return Response.json({})
    })

    const workItems = await withFetchMock(fetchMock, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* AzureDevOpsClient
          return yield* client.getPullRequestWorkItems({
            context,
            token,
            workItemRefs: [{ id: "123" }],
          })
        }).pipe(Effect.provide(AzureDevOpsClientLive)),
      ),
    )

    expect(titleBatchRequests).toEqual([[456]])
    expect(workItems[0]?.parent).toEqual({
      id: 456,
      title: "Parent title",
    })
  })
})
