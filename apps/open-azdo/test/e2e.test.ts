import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import * as ConfigProvider from "effect/ConfigProvider"

import { executeReview } from "../src/Cli"
import {
  createFixtureRepo,
  createMockFetch,
  createTempDir,
  makeBaseEnv,
  makeFetchMock,
  makeReviewCliInput,
  makeSilentRuntimeLayer,
} from "./helpers"

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
  | { readonly type: "success"; readonly output?: string }
  | { readonly type: "failure"; readonly message: string }

type FixtureRepo = Awaited<ReturnType<typeof createFixtureRepo>>

const encodeOpenCodeOutput = (
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
) =>
  [
    JSON.stringify({
      type: "message.part.updated",
      sessionID: "ses_test",
      part: {
        id: "prt_finish",
        sessionID: "ses_test",
        messageID: "msg_test",
        type: "step-finish",
        cost: usage.cost,
        tokens: usage.tokens,
      },
    }),
    JSON.stringify({
      type: "text",
      sessionID: "ses_test",
      part: {
        id: "prt_text",
        sessionID: "ses_test",
        messageID: "msg_test",
        type: "text",
        text: JSON.stringify(payload),
      },
    }),
  ].join("\n")

const successfulReviewOutput = encodeOpenCodeOutput({
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

const passingFollowUpOutput = encodeOpenCodeOutput(
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

const writeExecutable = async (path: string, script: string) => {
  await writeFile(path, script, "utf8")
  await chmod(path, 0o755)
}

const writeReviewScript = (path: string, script: ReviewScript) =>
  script.type === "success"
    ? writeExecutable(
        path,
        `#!/usr/bin/env bash
printf '%s\n' '${script.output ?? successfulReviewOutput}'
`,
      )
    : writeExecutable(
        path,
        `#!/usr/bin/env bash
echo "${script.message}" >&2
exit 1
`,
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

const parseRequestBody = (body: BodyInit | null | undefined) => JSON.parse(typeof body === "string" ? body : "{}")

const extractCommentContent = (body: BodyInit | null | undefined) => {
  const parsed = parseRequestBody(body)
  return parsed.content ?? parsed.comments?.[0]?.content ?? ""
}

const runReview = (repoDir: string, env: Record<string, string>) => {
  const cliInput = makeReviewCliInput({
    model: Option.some("openai/gpt-5.4"),
    workspace: Option.some(repoDir),
    collectionUrl: Option.some("https://dev.azure.com/acme"),
    project: Option.some("project"),
    repositoryId: Option.some("repo-1"),
    pullRequestId: Option.some(42),
  })

  return Effect.runPromise(
    executeReview.pipe(
      Effect.provide(
        makeSilentRuntimeLayer(cliInput).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env,
              }),
            ),
          ),
        ),
      ),
    ),
  )
}

const runReviewScenario = async ({
  opencode,
  envOverrides = {},
  buildThreadsResponse = () => Response.json({ value: [] }),
}: {
  readonly opencode: ReviewScript
  readonly envOverrides?: Record<string, string> | ((fixture: FixtureRepo) => Record<string, string>)
  readonly buildThreadsResponse?: (fixture: FixtureRepo) => Response
}) => {
  const fixture = await createFixtureRepo()
  const binDir = await createTempDir("open-azdo-bin-")
  const opencodePath = join(binDir, "opencode")

  await mkdir(binDir, { recursive: true })
  await writeReviewScript(opencodePath, opencode)

  const { fetchMock, calls } = makeFetchMock((url, init) => {
    if (url.endsWith("/pullRequests/42") && init?.method === "GET") {
      return Response.json({
        title: "Feature PR",
        description: "Adds a new export",
      })
    }

    if (url.endsWith("/threads?api-version=7.1") && init?.method === "GET") {
      return buildThreadsResponse(fixture)
    }

    return Response.json({ id: calls.length })
  })

  const originalFetch = globalThis.fetch
  const originalPath = process.env.PATH
  const configEnv = {
    ...makeBaseEnv(),
    BUILD_SOURCESDIRECTORY: fixture.repoDir,
    ...(typeof envOverrides === "function" ? envOverrides(fixture) : envOverrides),
  }

  globalThis.fetch = createMockFetch(fetchMock, originalFetch)
  process.env.PATH = `${binDir}:${originalPath ?? ""}`

  try {
    const exitCode = await runReview(fixture.repoDir, configEnv)
    return { calls, exitCode, fixture }
  } finally {
    globalThis.fetch = originalFetch

    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }

    await rm(binDir, { recursive: true, force: true })
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
})
