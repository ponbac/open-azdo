import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as ConfigProvider from "effect/ConfigProvider"
import { Effect, Layer, Option, Redacted } from "effect"
import * as Duration from "effect/Duration"

import { BaseRuntimeLayer } from "../src/app/Runtime"
import type { ExistingThread, PullRequestMetadata } from "../src/azdo/Schemas"
import { AzureDevOpsClient, type AzureDevOpsClientShape } from "../src/azdo/Services/AzureDevOpsClient"
import { AppConfig, makeAppConfigLayer, type AppConfigShape, type ReviewCliInput } from "../src/config/AppConfig"
import { GitExecLive } from "../src/git/Layers/GitExec"
import { type PullRequestDiff } from "../src/git/PullRequestDiff"
import { GitExec, type GitExecShape } from "../src/git/Services/GitExec"
import { OpenCodeRunnerLive } from "../src/opencode/Layers/OpenCodeRunner"
import {
  OpenCodeRunner,
  type OpenCodeRunRequest,
  type OpenCodeRunnerShape,
} from "../src/opencode/Services/OpenCodeRunner"
import { ProcessRunnerLive } from "../src/platform/Layers/ProcessRunner"
import {
  ProcessRunner,
  type CommandExecutionResult,
  type ExecuteCommandInput,
} from "../src/platform/Services/ProcessRunner"
import type { NormalizedReviewResult, ReviewFinding } from "../src/review/ReviewOutput"
import { encodeMarker, fingerprintFinding } from "../src/review/ThreadReconciliation"

const compactEnv = (env: Record<string, string | undefined>) => {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value
    }
  }

  return result
}

export const makeBaseEnv = (): Record<string, string> => ({
  SYSTEM_ACCESSTOKEN: "system-token",
  SYSTEM_COLLECTIONURI: "https://dev.azure.com/acme",
  SYSTEM_TEAMPROJECT: "project",
  BUILD_REPOSITORY_ID: "repo-1",
  SYSTEM_PULLREQUEST_PULLREQUESTID: "42",
  SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/main",
  BUILD_SOURCESDIRECTORY: "/tmp/workspace",
  BUILD_BUILDID: "99",
  BUILD_BUILDNUMBER: "99",
})

export const makeReviewCliInput = (overrides: Partial<ReviewCliInput> = {}): ReviewCliInput => ({
  model: Option.none(),
  opencodeVariant: Option.none(),
  opencodeTimeout: Option.none(),
  workspace: Option.none(),
  organization: Option.none(),
  project: Option.none(),
  repositoryId: Option.none(),
  pullRequestId: Option.none(),
  collectionUrl: Option.none(),
  agent: Option.none(),
  promptFile: Option.none(),
  dryRun: false,
  json: false,
  ...overrides,
})

export const resolveAppConfig = (cliInput: ReviewCliInput, env: Record<string, string | undefined>) =>
  Effect.gen(function* () {
    return yield* AppConfig
  }).pipe(
    Effect.provide(
      makeAppConfigLayer(cliInput).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: compactEnv(env),
            }),
          ),
        ),
      ),
    ),
  )

export const makeAppConfig = (overrides: Partial<AppConfigShape> = {}): AppConfig["Service"] =>
  ({
    command: "review",
    model: "openai/gpt-5.4",
    opencodeTimeout: Duration.minutes(10),
    workspace: "/tmp/workspace",
    organization: "acme",
    project: "project",
    repositoryId: "repo-1",
    pullRequestId: 42,
    collectionUrl: "https://dev.azure.com/acme",
    agent: "azdo-review",
    dryRun: false,
    json: false,
    systemAccessToken: Redacted.make("system-token"),
    targetBranch: "refs/heads/main",
    buildId: "99",
    buildNumber: "99",
    ...overrides,
  }) as AppConfig["Service"]

export const makePullRequestMetadata = (overrides: Partial<PullRequestMetadata> = {}): PullRequestMetadata => ({
  title: "Feature PR",
  description: "Adds a new export",
  ...overrides,
})

export const makePullRequestDiff = (overrides: Partial<PullRequestDiff> = {}): PullRequestDiff => ({
  baseRef: "abc123",
  headRef: "HEAD",
  diffText: "",
  changedFiles: [],
  changedLinesByFile: new Map<string, Set<number>>(),
  ...overrides,
})

export const makeReviewFinding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  severity: "high",
  confidence: "high",
  title: "Finding title",
  body: "Finding body",
  filePath: "src/example.ts",
  line: 2,
  ...overrides,
})

export const makeNormalizedReviewResult = (
  findings: ReadonlyArray<ReviewFinding>,
  inlineFindings: ReadonlyArray<ReviewFinding> = findings,
): NormalizedReviewResult => ({
  summary: "Summary",
  verdict: "concerns",
  findings: [...findings],
  inlineFindings: [...inlineFindings],
  summaryOnlyFindings: findings.filter((finding) => !inlineFindings.includes(finding)),
  unmappedNotes: [],
})

export const makeManagedSummaryThread = (): ExistingThread => ({
  id: 1,
  status: 1,
  comments: [
    {
      id: 10,
      content: `summary\n${encodeMarker({ kind: "summary", fingerprint: "summary" })}`,
    },
  ],
})

export const makeManagedFindingThread = (finding: ReviewFinding, threadId = 2): ExistingThread => ({
  id: threadId,
  status: 1,
  comments: [
    {
      id: threadId * 10,
      content: `finding\n${encodeMarker({ kind: "finding", fingerprint: fingerprintFinding(finding) })}`,
    },
  ],
  threadContext: {
    filePath: `/${finding.filePath}`,
    rightFileStart: { line: finding.line },
    rightFileEnd: { line: finding.endLine ?? finding.line },
  },
})

export type FetchCall = {
  readonly url: string
  readonly init: RequestInit | undefined
}

export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

export const makeFetchMock = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: FetchCall[] = []
  const fetchMock: FetchLike = async (url, init) => {
    const normalizedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url
    calls.push({ url: normalizedUrl, init })
    return handler(normalizedUrl, init)
  }

  return {
    calls,
    fetchMock,
  }
}

export const createMockFetch = (fetchMock: FetchLike, originalFetch: typeof fetch): typeof fetch => {
  const mockedFetch: typeof fetch = (input, init) => fetchMock(input, init)
  mockedFetch.preconnect = originalFetch.preconnect.bind(originalFetch)
  return mockedFetch
}

export const createTempDir = async (prefix: string) => mkdtemp(join(tmpdir(), prefix))

export const createFixtureRepo = async () => {
  const repoDir = await createTempDir("open-azdo-repo-")
  runGit(repoDir, ["init", "-b", "main"])
  runGit(repoDir, ["config", "user.name", "Open AZDO"])
  runGit(repoDir, ["config", "user.email", "open-azdo@example.com"])
  await mkdir(join(repoDir, "src"), { recursive: true })
  await writeFile(join(repoDir, "src/example.ts"), "export const value = 1\n", "utf8")
  runGit(repoDir, ["add", "."])
  runGit(repoDir, ["commit", "-m", "main"])
  const mainSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()
  runGit(repoDir, ["update-ref", "refs/remotes/origin/main", mainSha])
  runGit(repoDir, ["checkout", "-b", "feature"])
  await writeFile(join(repoDir, "src/example.ts"), "export const value = 2\nexport const next = 3\n", "utf8")
  runGit(repoDir, ["commit", "-am", "feature"])

  return {
    mainSha,
    repoDir,
  }
}

export const createSyntheticMergeRepo = async () => {
  const repoDir = await createTempDir("open-azdo-merge-")
  runGit(repoDir, ["init", "-b", "main"])
  runGit(repoDir, ["config", "user.name", "Open AZDO"])
  runGit(repoDir, ["config", "user.email", "open-azdo@example.com"])
  await mkdir(join(repoDir, "src"), { recursive: true })
  await writeFile(join(repoDir, "src/example.ts"), "export const value = 1\n", "utf8")
  runGit(repoDir, ["add", "."])
  runGit(repoDir, ["commit", "-m", "base"])
  runGit(repoDir, ["checkout", "-b", "feature"])
  await writeFile(join(repoDir, "src/example.ts"), "export const value = 1\nexport const added = true\n", "utf8")
  runGit(repoDir, ["commit", "-am", "feature"])
  runGit(repoDir, ["checkout", "main"])
  await writeFile(join(repoDir, "README.md"), "# Main\n", "utf8")
  runGit(repoDir, ["add", "README.md"])
  runGit(repoDir, ["commit", "-m", "main-change"])
  runGit(repoDir, ["merge", "--no-ff", "feature", "-m", "merge"])

  return {
    repoDir,
  }
}

export const makeProcessRunner = (
  execute: (input: ExecuteCommandInput) => Effect.Effect<CommandExecutionResult, never>,
): ProcessRunner["Service"] => ({
  execute,
})

export const makeGitExec = (execute: GitExecShape["execute"]): GitExec["Service"] => ({
  execute,
})

export const makeAzureDevOpsClient = (
  overrides: Partial<AzureDevOpsClientShape> = {},
): AzureDevOpsClient["Service"] => ({
  getPullRequestMetadata: () => Effect.succeed(makePullRequestMetadata()),
  listThreads: () => Effect.succeed([]),
  updateThreadStatus: () => Effect.void,
  updateComment: () => Effect.void,
  createThread: () => Effect.void,
  ...overrides,
})

export const makeOpenCodeRunner = (run: OpenCodeRunnerShape["run"]): OpenCodeRunner["Service"] => ({
  run,
})

export const makeGitExecLayer = (service: GitExec["Service"]) => Layer.succeed(GitExec, service)

export const makeAzureDevOpsClientLayer = (service: AzureDevOpsClient["Service"]) =>
  Layer.succeed(AzureDevOpsClient, service)

export const makeOpenCodeRunnerLayer = (service: OpenCodeRunner["Service"]) => Layer.succeed(OpenCodeRunner, service)

export const makeRealGitExecLayer = () =>
  GitExecLive.pipe(Layer.provide(ProcessRunnerLive.pipe(Layer.provide(BaseRuntimeLayer))))

export const makeOpenCodeLiveLayer = (runner: ProcessRunner["Service"]) =>
  OpenCodeRunnerLive.pipe(Layer.provide(Layer.mergeAll(BaseRuntimeLayer, Layer.succeed(ProcessRunner, runner))))

export const makeOpenCodeRunRequest = (overrides: Partial<OpenCodeRunRequest> = {}): OpenCodeRunRequest => ({
  workspace: "/tmp/workspace",
  model: "openai/gpt-5.4",
  agent: "azdo-review",
  variant: undefined,
  timeout: Duration.minutes(10),
  prompt: "Review this pull request.",
  inheritedEnv: {},
  ...overrides,
})

const runGit = (cwd: string, args: ReadonlyArray<string>) => {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`)
  }

  return result.stdout
}
