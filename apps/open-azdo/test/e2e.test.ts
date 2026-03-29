import { rm } from "node:fs/promises"

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import * as ConfigProvider from "effect/ConfigProvider"
import { FetchHttpClient } from "effect/unstable/http"

import { executeReview } from "../src/Cli"
import {
  createFixtureRepo,
  createTargetMergeFollowUpRepo,
  type FetchLike,
  makeBaseEnv,
  makeFetchMock,
  makeOpenCodeRunner,
  makeReviewCliInput,
  makeSilentRuntimeLayer,
} from "./helpers"
import type { OpenCodeRunResult } from "@open-azdo/core/opencode"

type ManagedReviewState = {
  readonly schemaVersion: number
  readonly reviewedCommit: string
  readonly pullRequestBaseRef: string
  readonly verdict: "pass" | "concerns" | "fail"
  readonly severityCounts: {
    readonly low: number
    readonly medium: number
    readonly high: number
    readonly critical: number
  }
  readonly findingsCount: number
  readonly inlineFindingsCount: number
  readonly unmappedNotesCount: number
  readonly reviewHistory?: ReadonlyArray<{
    readonly reviewedCommit: string
    readonly reviewMode: "full" | "follow-up"
    readonly model: string
    readonly variant?: string
    readonly buildNumber?: string
    readonly buildId?: string
    readonly buildLink?: string
    readonly costUsd?: number
    readonly tokens?: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cacheRead: number
      readonly cacheWrite: number
    }
  }>
}

type ManagedFinding = {
  readonly severity: "low" | "medium" | "high" | "critical"
  readonly confidence: "low" | "medium" | "high"
  readonly title: string
  readonly body: string
  readonly filePath: string
  readonly line: number
  readonly endLine?: number
  readonly suggestion?: string
}

type ReviewScript =
  | { readonly type: "success"; readonly output?: OpenCodeRunResult }
  | { readonly type: "failure"; readonly message: string }

type FixtureRepo = Awaited<ReturnType<typeof createFixtureRepo>>
type TestThread = {
  readonly id: number
  readonly status: number
  readonly comments: ReadonlyArray<{
    readonly id: number
    readonly content: string
    readonly publishedDate?: string
    readonly commentType?: string
    readonly author?: {
      readonly displayName: string
    }
  }>
  readonly threadContext?: {
    readonly filePath: string
    readonly rightFileStart: {
      readonly line: number
    }
    readonly rightFileEnd: {
      readonly line: number
    }
  }
}

const makePromptResponse = (
  payload: unknown,
  usage = {
    cost: 0.1234,
    tokens: {
      input: 1200,
      output: 345,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
): OpenCodeRunResult => ({
  response: JSON.stringify(payload),
  structured: payload,
  sessionId: "ses_test",
  usage: {
    costUsd: usage.cost,
    tokens: {
      input: usage.tokens.input,
      output: usage.tokens.output,
      reasoning: usage.tokens.reasoning,
      cacheRead: usage.tokens.cacheRead,
      cacheWrite: usage.tokens.cacheWrite,
    },
  },
})

const successfulReviewOutput = makePromptResponse({
  summary: "Found one issue",
  verdict: "concerns",
  findings: [
    {
      severity: "high",
      confidence: "high",
      title: "Use the updated value",
      body: "The change introduces a new exported symbol.",
      filePath: "src/example.ts",
      line: 2,
    },
  ],
  unmappedNotes: [],
})

const passingFollowUpOutput = makePromptResponse(
  {
    summary: "No new issues in the follow-up diff",
    verdict: "pass",
    findings: [],
    unmappedNotes: [],
  },
  {
    cost: 0.0456,
    tokens: {
      input: 900,
      output: 120,
      reasoning: 50,
      cacheRead: 10,
      cacheWrite: 0,
    },
  },
)

const makeManagedReviewState = (overrides: Partial<ManagedReviewState> = {}): ManagedReviewState => ({
  schemaVersion: 2,
  reviewedCommit: "reviewed-sha",
  pullRequestBaseRef: "base-sha",
  verdict: "concerns",
  severityCounts: {
    low: 0,
    medium: 0,
    high: 1,
    critical: 0,
  },
  findingsCount: 1,
  inlineFindingsCount: 1,
  unmappedNotesCount: 0,
  ...overrides,
})

const makeThreadsResponse = (threads: ReadonlyArray<object>) => Response.json({ value: threads })

const makeManagedSummaryThread = (reviewState: ManagedReviewState) => ({
  id: 1,
  status: 1,
  comments: [
    {
      id: 10,
      content: `summary\n<!-- open-azdo-review:${JSON.stringify(reviewState)} -->`,
    },
  ],
})

const makeManagedFindingThread = (finding: ManagedFinding) => ({
  id: 2,
  status: 1,
  comments: [
    {
      id: 20,
      content: `finding\n<!-- open-azdo:${JSON.stringify({
        kind: "finding",
        fingerprint: "previous-finding",
        finding,
      })} -->`,
    },
  ],
  threadContext: {
    filePath: `/${finding.filePath}`,
    rightFileStart: { line: finding.line },
    rightFileEnd: { line: finding.endLine ?? finding.line },
  },
})

const makeHumanThread = (overrides: Partial<TestThread> = {}): TestThread => ({
  id: 30,
  status: 1,
  comments: [
    {
      id: 300,
      content: "Human thread context",
      publishedDate: "2026-03-24T10:00:00.000Z",
      commentType: "text",
      author: {
        displayName: "Reviewer",
      },
    },
  ],
  ...overrides,
})

const parseRequestBody = (body: BodyInit | null | undefined) => {
  if (typeof body === "string") {
    return JSON.parse(body)
  }

  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body))
  }

  return {}
}

const isWorkItemCommentsUrl = (url: string) => {
  const parsed = new URL(url)
  return (
    parsed.pathname === "/acme/project/_apis/wit/workItems/123/comments" &&
    parsed.searchParams.get("$top") === "20" &&
    parsed.searchParams.get("$expand") === "renderedText" &&
    parsed.searchParams.get("api-version") === "7.1-preview.4"
  )
}

const extractCommentContent = (body: BodyInit | null | undefined) => {
  const parsed = parseRequestBody(body)
  return parsed.content ?? parsed.comments?.[0]?.content ?? ""
}

const runReview = (
  repoDir: string,
  env: Record<string, string>,
  fetchMock: FetchLike,
  opencode: ReviewScript,
  onPrompt?: (prompt: string) => void,
) => {
  const cliInput = makeReviewCliInput({
    model: Option.some("openai/gpt-5.4"),
    workspace: Option.some(repoDir),
    collectionUrl: Option.some("https://dev.azure.com/acme"),
    project: Option.some("project"),
    repositoryId: Option.some("repo-1"),
    pullRequestId: Option.some(42),
  })
  const openCodeRunner = makeOpenCodeRunner((request) => {
    onPrompt?.(request.prompt)

    if (opencode.type === "failure") {
      return Effect.die(opencode.message)
    }

    return Effect.succeed(opencode.output ?? successfulReviewOutput)
  })

  const effect = executeReview.pipe(
    Effect.provide(
      makeSilentRuntimeLayer(cliInput, {
        openCodeRunner,
      }).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env,
            }),
          ),
        ),
      ),
    ),
  )

  return Effect.runPromise(
    effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchMock as typeof globalThis.fetch)),
  )
}

const runReviewScenario = async ({
  opencode,
  envOverrides = {},
  buildThreadsResponse = () => Response.json({ value: [] }),
  buildPullRequestResponse = () =>
    Response.json({
      title: "Feature PR",
      description: "Adds a new export",
      workItemRefs: [],
    }),
  buildExtraResponse,
  capturePrompt = false,
}: {
  readonly opencode: ReviewScript
  readonly envOverrides?: Record<string, string> | ((fixture: FixtureRepo) => Record<string, string>)
  readonly buildThreadsResponse?: (fixture: FixtureRepo) => Response
  readonly buildPullRequestResponse?: (fixture: FixtureRepo) => Response
  readonly buildExtraResponse?: (
    url: string,
    init: RequestInit | undefined,
    fixture: FixtureRepo,
  ) => Response | undefined
  readonly capturePrompt?: boolean
}) => {
  const fixture = await createFixtureRepo()
  let prompt: string | undefined

  const { fetchMock, calls } = makeFetchMock((url, init) => {
    if (url.includes("/pullRequests/42?includeWorkItemRefs=true&api-version=7.1") && init?.method === "GET") {
      return buildPullRequestResponse(fixture)
    }

    if (url.endsWith("/threads?api-version=7.1") && init?.method === "GET") {
      return buildThreadsResponse(fixture)
    }

    const extraResponse = buildExtraResponse?.(url, init, fixture)
    if (extraResponse) {
      return extraResponse
    }

    return Response.json({ id: calls.length })
  })

  const configEnv = {
    ...makeBaseEnv(),
    BUILD_SOURCESDIRECTORY: fixture.repoDir,
    ...(typeof envOverrides === "function" ? envOverrides(fixture) : envOverrides),
  }

  try {
    const exitCode = await runReview(fixture.repoDir, configEnv, fetchMock, opencode, (value) => {
      if (capturePrompt) {
        prompt = value
      }
    })
    return {
      calls,
      exitCode,
      fixture,
      prompt,
    }
  } finally {
    await rm(fixture.repoDir, { recursive: true, force: true })
  }
}

describe("e2e", () => {
  test("runs the review workflow against a fixture repo and mocked Azure DevOps", async () => {
    const result = await runReviewScenario({
      opencode: { type: "success" },
    })

    const summaryCreate = result.calls.find(
      (call) =>
        call.init?.method === "POST" &&
        call.url.endsWith("/threads?api-version=7.1") &&
        extractCommentContent(call.init?.body).includes("Verdict: **concerns**"),
    )
    const summaryContent = extractCommentContent(summaryCreate?.init?.body)

    expect(result.exitCode).toBe(0)
    expect(result.calls.filter((call) => call.init?.method === "POST")).toHaveLength(2)
    expect(summaryContent).toContain("$0.1234")
  })

  test("includes connected work item context in the generated prompt", async () => {
    const result = await runReviewScenario({
      opencode: { type: "success" },
      capturePrompt: true,
      buildPullRequestResponse: () =>
        Response.json({
          title: "Feature PR",
          description: "Adds a new export",
          workItemRefs: [{ id: "123" }],
        }),
      buildExtraResponse: (url, init) => {
        if (url.endsWith("/_apis/wit/workitemsbatch?api-version=7.1") && init?.method === "POST") {
          const body = parseRequestBody(init.body)

          if (body.fields.includes("System.Title") && body.fields.length === 1) {
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
                  "System.Description": "<p>Hello world</p>",
                  "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>Do the thing</li></ul>",
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
          return Response.json({
            comments: [
              {
                renderedText: "<p>Rendered comment</p>",
                createdDate: "2026-03-21T10:00:00.000Z",
                isDeleted: false,
                createdBy: {
                  displayName: "Reviewer",
                },
              },
            ],
          })
        }

        return undefined
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.prompt).toContain('"title":"Fix regression"')
    expect(result.prompt).toContain('"acceptanceCriteriaMarkdown":"-   Do the thing"')
    expect(result.prompt).toContain('"markdown":"Rendered comment"')
  })

  test("includes eligible pull-request thread context in the generated prompt", async () => {
    const result = await runReviewScenario({
      opencode: { type: "success" },
      capturePrompt: true,
      buildThreadsResponse: () =>
        makeThreadsResponse([
          makeHumanThread(),
          makeHumanThread({
            id: 31,
            comments: [
              {
                id: 310,
                content:
                  'Earlier finding\n<!-- open-azdo:{"kind":"finding","fingerprint":"previous-finding","finding":{"title":"Old finding"}} -->',
                publishedDate: "2026-03-24T11:00:00.000Z",
                commentType: "text",
                author: {
                  displayName: "Open AZDO",
                },
              },
              {
                id: 311,
                content: "I fixed this already in the latest patch.",
                publishedDate: "2026-03-24T12:00:00.000Z",
                commentType: "text",
                author: {
                  displayName: "Author",
                },
              },
            ],
          }),
          makeHumanThread({
            id: 32,
            comments: [
              {
                id: 320,
                content:
                  'Bot-only finding\n<!-- open-azdo:{"kind":"finding","fingerprint":"bot-only","finding":{"title":"Bot only"}} -->',
                publishedDate: "2026-03-24T09:00:00.000Z",
                commentType: "text",
                author: {
                  displayName: "Open AZDO",
                },
              },
            ],
          }),
          makeHumanThread({
            id: 33,
            comments: [
              {
                id: 330,
                content: "Policy status has been updated",
                publishedDate: "2026-03-24T08:00:00.000Z",
                author: {
                  displayName: "Microsoft.VisualStudio.Services.TFS",
                },
              },
            ],
          }),
        ]),
    })

    expect(result.exitCode).toBe(0)
    expect(result.prompt).toContain('"pullRequestThreads"')
    expect(result.prompt).toContain("Human thread context")
    expect(result.prompt).toContain("Earlier finding")
    expect(result.prompt).toContain("I fixed this already in the latest patch.")
    expect(result.prompt).not.toContain("previous-finding")
    expect(result.prompt).not.toContain("Bot-only finding")
    expect(result.prompt).not.toContain("Policy status has been updated")
  })

  test("skips same-commit reruns and only updates the managed summary thread", async () => {
    const result = await runReviewScenario({
      opencode: {
        type: "failure",
        message: "opencode should not run on skipped reviews",
      },
      envOverrides: ({ featureSha }: FixtureRepo) => ({
        SYSTEM_PULLREQUEST_SOURCECOMMITID: featureSha,
      }),
      buildThreadsResponse: ({ featureSha, mainSha }) =>
        makeThreadsResponse([
          makeManagedSummaryThread(
            makeManagedReviewState({
              reviewedCommit: featureSha,
              pullRequestBaseRef: mainSha,
              reviewHistory: [
                {
                  reviewedCommit: mainSha,
                  reviewMode: "full",
                  model: "openai/gpt-5.4",
                  buildNumber: "99",
                  buildId: "99",
                  buildLink: "https://dev.azure.com/acme/project/_build/results?buildId=99",
                  costUsd: 0.1234,
                },
              ],
            }),
          ),
        ]),
    })

    const summaryUpdate = result.calls.find((call) => call.url.endsWith("/threads/1/comments/10?api-version=7.1"))
    const summaryContent = extractCommentContent(summaryUpdate?.init?.body)

    expect(result.exitCode).toBe(0)
    expect(result.calls.filter((call) => call.init?.method === "PATCH")).toHaveLength(2)
    expect(result.calls.filter((call) => call.init?.method === "POST")).toHaveLength(0)
    expect(summaryContent).toContain("$0.1234")
    expect(summaryContent).not.toContain("$0.0456")
  })

  test("reruns a full review when the stored managed-review base differs", async () => {
    const result = await runReviewScenario({
      opencode: { type: "success" },
      envOverrides: ({ featureSha }: FixtureRepo) => ({
        SYSTEM_PULLREQUEST_SOURCECOMMITID: featureSha,
      }),
      buildThreadsResponse: ({ featureSha }) =>
        makeThreadsResponse([
          makeManagedSummaryThread(
            makeManagedReviewState({
              reviewedCommit: featureSha,
              pullRequestBaseRef: "stale-base-sha",
            }),
          ),
        ]),
    })

    expect(result.exitCode).toBe(0)
    expect(
      result.calls.filter((call) => call.init?.method === "GET" && call.url.endsWith("/threads?api-version=7.1")),
    ).toHaveLength(2)
    expect(result.calls.filter((call) => call.init?.method === "POST")).toHaveLength(1)
  })

  test("keeps untouched older managed findings in the follow-up summary", async () => {
    const result = await runReviewScenario({
      opencode: {
        type: "success",
        output: passingFollowUpOutput,
      },
      envOverrides: ({ featureSha }: FixtureRepo) => ({
        SYSTEM_PULLREQUEST_SOURCECOMMITID: featureSha,
      }),
      buildThreadsResponse: ({ mainSha }) =>
        makeThreadsResponse([
          makeManagedSummaryThread(
            makeManagedReviewState({
              reviewedCommit: mainSha,
              pullRequestBaseRef: mainSha,
              reviewHistory: [
                {
                  reviewedCommit: mainSha,
                  reviewMode: "full",
                  model: "openai/gpt-5.4",
                  buildNumber: "99",
                  buildId: "99",
                  buildLink: "https://dev.azure.com/acme/project/_build/results?buildId=99",
                  costUsd: 0.1234,
                },
              ],
            }),
          ),
          makeManagedFindingThread({
            severity: "high",
            confidence: "high",
            title: "Previous finding",
            body: "This older issue is still open.",
            filePath: "src/other.ts",
            line: 20,
          }),
        ]),
    })

    const summaryUpdate = result.calls.find((call) => call.url.endsWith("/threads/1/comments/10?api-version=7.1"))
    const summaryContent = parseRequestBody(summaryUpdate?.init?.body).content

    expect(result.exitCode).toBe(0)
    expect(summaryContent).toContain("Verdict: **concerns**")
    expect(summaryContent).toContain("Still tracking 1 managed finding")
    expect(summaryContent).toContain("$0.1234")
    expect(summaryContent).toContain("$0.0456")
  })

  test("falls back to a full review when a follow-up range only adds a merge from the target branch", async () => {
    const fixture = await createTargetMergeFollowUpRepo()
    let prompt: string | undefined

    const { fetchMock, calls } = makeFetchMock((url, init) => {
      if (url.includes("/pullRequests/42?includeWorkItemRefs=true&api-version=7.1") && init?.method === "GET") {
        return Response.json({
          title: "Feature PR",
          description: "Adds a new export",
          workItemRefs: [],
        })
      }

      if (url.endsWith("/threads?api-version=7.1") && init?.method === "GET") {
        return makeThreadsResponse([
          makeManagedSummaryThread(
            makeManagedReviewState({
              reviewedCommit: fixture.reviewedSha,
              pullRequestBaseRef: fixture.targetSha,
            }),
          ),
        ])
      }

      return Response.json({ id: calls.length })
    })

    try {
      const exitCode = await runReview(
        fixture.repoDir,
        {
          ...makeBaseEnv(),
          BUILD_SOURCESDIRECTORY: fixture.repoDir,
          SYSTEM_PULLREQUEST_SOURCECOMMITID: fixture.headSha,
        },
        fetchMock,
        { type: "success" },
        (value) => {
          prompt = value
        },
      )

      expect(exitCode).toBe(0)
      expect(prompt).toContain("This is a full pull-request review over the scoped changed files.")
      expect(prompt).not.toContain("This is a follow-up review.")
      expect(prompt).toContain('"path":"src/example.ts"')
      expect(prompt).not.toContain("open-azdo.yaml")
    } finally {
      await rm(fixture.repoDir, { recursive: true, force: true })
    }
  })
})
