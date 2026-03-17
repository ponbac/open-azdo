import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import { Redacted } from "effect"

import type { ReviewConfig } from "../src/config"
import type { NormalizedReviewResult, ReviewFinding } from "../src/review-output"
import { encodeMarker, fingerprintFinding } from "../src/thread-reconciliation"

export const makeBaseEnv = () => ({
  SYSTEM_ACCESSTOKEN: "system-token",
  SYSTEM_COLLECTIONURI: "https://dev.azure.com/acme",
  SYSTEM_TEAMPROJECT: "project",
  BUILD_REPOSITORY_ID: "repo-1",
  SYSTEM_PULLREQUEST_PULLREQUESTID: "42",
  BUILD_SOURCESDIRECTORY: "/tmp/workspace",
})

export const makeReviewConfig = (overrides: Partial<ReviewConfig> = {}): ReviewConfig => ({
  command: "review",
  model: "openai/gpt-5.4",
  workspace: overrides.workspace ?? "/tmp/workspace",
  organization: "acme",
  project: "project",
  repositoryId: "repo-1",
  pullRequestId: 42,
  collectionUrl: "https://dev.azure.com/acme",
  agent: "azdo-review",
  promptFile: undefined,
  dryRun: false,
  json: false,
  systemAccessToken: Redacted.make("system-token"),
  targetBranch: "refs/heads/main",
  sourceVersion: undefined,
  buildId: "99",
  buildNumber: "99",
  buildUri: undefined,
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
  findings: ReviewFinding[],
  inlineFindings: ReviewFinding[] = findings,
): NormalizedReviewResult => ({
  summary: "Summary",
  verdict: "concerns",
  findings,
  inlineFindings,
  summaryOnlyFindings: findings.filter((finding) => !inlineFindings.includes(finding)),
  unmappedNotes: [],
})

export const makeManagedSummaryThread = () => ({
  id: 1,
  status: 1,
  comments: [
    {
      id: 10,
      content: `summary\n${encodeMarker({ kind: "summary", fingerprint: "summary" })}`,
    },
  ],
  threadContext: undefined,
})

export const makeManagedFindingThread = (finding: ReviewFinding, threadId = 2) => ({
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
    repoDir,
    mainSha,
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

export const makeFetchMock = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    const normalizedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url
    calls.push({ url: normalizedUrl, init })
    return handler(normalizedUrl, init)
  }

  return {
    fetchMock,
    calls,
  }
}

const runGit = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`)
  }

  return result.stdout
}
