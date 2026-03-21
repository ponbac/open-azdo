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
const encodeOpenCodeOutput = (payload) => JSON.stringify({ text: JSON.stringify(payload) })
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
const passingFollowUpOutput = encodeOpenCodeOutput({
  summary: "No new issues in the follow-up diff",
  verdict: "pass",
  findings: [],
  unmappedNotes: [],
})
const writeExecutable = async (path, script) => {
  await writeFile(path, script, "utf8")
  await chmod(path, 0o755)
}
const writeReviewScript = (path, script) =>
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
const makeManagedReviewState = (overrides = {}) => ({
  schemaVersion: 1,
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
const makeThreadsResponse = (threads) => Response.json({ value: threads })
const makeManagedSummaryThread = (reviewState) => ({
  id: 1,
  status: 1,
  comments: [
    {
      id: 10,
      content: `summary\n<!-- open-azdo-review:${JSON.stringify(reviewState)} -->`,
    },
  ],
})
const makeManagedFindingThread = (finding) => ({
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
const parseRequestBody = (body) => JSON.parse(typeof body === "string" ? body : "{}")
const runReview = (repoDir, env) => {
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
    expect(result.exitCode).toBe(0)
    expect(result.calls.filter((call) => call.init?.method === "POST")).toHaveLength(2)
  })
  test("skips same-commit reruns and only updates the managed summary thread", async () => {
    const result = await runReviewScenario({
      opencode: {
        type: "failure",
        message: "opencode should not run on skipped reviews",
      },
      envOverrides: ({ featureSha }) => ({
        SYSTEM_PULLREQUEST_SOURCECOMMITID: featureSha,
      }),
      buildThreadsResponse: ({ featureSha, mainSha }) =>
        makeThreadsResponse([
          makeManagedSummaryThread(
            makeManagedReviewState({
              reviewedCommit: featureSha,
              pullRequestBaseRef: mainSha,
            }),
          ),
        ]),
    })
    expect(result.exitCode).toBe(0)
    expect(result.calls.filter((call) => call.init?.method === "PATCH")).toHaveLength(2)
    expect(result.calls.filter((call) => call.init?.method === "POST")).toHaveLength(0)
  })
  test("reruns a full review when the stored managed-review base differs", async () => {
    const result = await runReviewScenario({
      opencode: { type: "success" },
      envOverrides: ({ featureSha }) => ({
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
      envOverrides: ({ featureSha }) => ({
        SYSTEM_PULLREQUEST_SOURCECOMMITID: featureSha,
      }),
      buildThreadsResponse: ({ mainSha }) =>
        makeThreadsResponse([
          makeManagedSummaryThread(
            makeManagedReviewState({
              reviewedCommit: mainSha,
              pullRequestBaseRef: mainSha,
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
  })
})
