import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, Logger } from "effect"
import * as Duration from "effect/Duration"

import { BaseRuntimeLayer } from "@open-azdo/core/base-runtime"
import { GitExec, GitExecLive, type GitExecShape, type PullRequestDiff } from "@open-azdo/core/git"
import { ProcessRunnerLive } from "@open-azdo/core/process-runner"

import { type OpenCodeRunRequest } from "../src/opencode/Services/OpenCodeRunner"
import { OpenCodeRunnerLayer } from "../src/opencode/Layers/OpenCodeRunner"
import {
  OpenCodeSdkRuntime,
  type OpenCodeSdkPromptRequest,
  type OpenCodeSdkPromptResult,
} from "../src/opencode/internal/Services/OpenCodeSdkRuntime"

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
  const featureSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()

  return {
    featureSha,
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
  const mainSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()
  runGit(repoDir, ["update-ref", "refs/remotes/origin/main", mainSha])
  runGit(repoDir, ["merge", "--no-ff", "feature", "-m", "merge"])
  const mergeSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()
  const featureSha = runGit(repoDir, ["rev-parse", "HEAD^2"]).trim()

  return {
    featureSha,
    mainSha,
    mergeSha,
    repoDir,
  }
}

export const createDeletionFollowUpRepo = async () => {
  const repoDir = await createTempDir("open-azdo-delete-follow-up-")
  runGit(repoDir, ["init", "-b", "main"])
  runGit(repoDir, ["config", "user.name", "Open AZDO"])
  runGit(repoDir, ["config", "user.email", "open-azdo@example.com"])
  await mkdir(join(repoDir, "src"), { recursive: true })
  await writeFile(
    join(repoDir, "src/example.ts"),
    ["export const keep = 1", "export const flagged = 2", "export const stay = 3", ""].join("\n"),
    "utf8",
  )
  runGit(repoDir, ["add", "."])
  runGit(repoDir, ["commit", "-m", "reviewed"])
  const reviewedSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()
  await writeFile(
    join(repoDir, "src/example.ts"),
    ["export const keep = 1", "export const stay = 3", ""].join("\n"),
    "utf8",
  )
  runGit(repoDir, ["commit", "-am", "delete-flagged-line"])
  const headSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()

  return {
    repoDir,
    reviewedSha,
    headSha,
  }
}

export const createTargetMergeFollowUpRepo = async () => {
  const repoDir = await createTempDir("open-azdo-target-merge-follow-up-")
  runGit(repoDir, ["init", "-b", "main"])
  runGit(repoDir, ["config", "user.name", "Open AZDO"])
  runGit(repoDir, ["config", "user.email", "open-azdo@example.com"])
  await mkdir(join(repoDir, "src"), { recursive: true })
  await writeFile(join(repoDir, "src/example.ts"), "export const value = 1\n", "utf8")
  await writeFile(join(repoDir, "open-azdo.yaml"), "steps:\n  - script: echo baseline\n", "utf8")
  runGit(repoDir, ["add", "."])
  runGit(repoDir, ["commit", "-m", "base"])
  const baseSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()
  runGit(repoDir, ["update-ref", "refs/remotes/origin/main", baseSha])
  runGit(repoDir, ["checkout", "-b", "feature"])
  await writeFile(join(repoDir, "src/example.ts"), "export const value = 2\nexport const next = 3\n", "utf8")
  runGit(repoDir, ["commit", "-am", "feature"])
  runGit(repoDir, ["checkout", "main"])
  await writeFile(join(repoDir, "README.md"), "# Main before review\n", "utf8")
  runGit(repoDir, ["add", "README.md"])
  runGit(repoDir, ["commit", "-m", "main-before-review"])
  const previousTargetSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()
  runGit(repoDir, ["update-ref", "refs/remotes/origin/main", previousTargetSha])
  runGit(repoDir, ["checkout", "feature"])
  runGit(repoDir, ["merge", "--no-ff", "main", "-m", "merge main before review"])
  const reviewedSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()
  runGit(repoDir, ["checkout", "main"])
  await writeFile(join(repoDir, "open-azdo.yaml"), "steps:\n  - task: NodeTool@0\n  - script: echo bootstrap\n", "utf8")
  runGit(repoDir, ["commit", "-am", "main-target-only"])
  const targetSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()
  runGit(repoDir, ["update-ref", "refs/remotes/origin/main", targetSha])
  runGit(repoDir, ["checkout", "feature"])
  runGit(repoDir, ["merge", "--no-ff", "main", "-m", "merge main after review"])
  const headSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()

  return {
    repoDir,
    reviewedSha,
    headSha,
    targetSha,
  }
}

export const createDeletedFileFollowUpRepo = async () => {
  const repoDir = await createTempDir("open-azdo-delete-file-follow-up-")
  runGit(repoDir, ["init", "-b", "main"])
  runGit(repoDir, ["config", "user.name", "Open AZDO"])
  runGit(repoDir, ["config", "user.email", "open-azdo@example.com"])
  await mkdir(join(repoDir, "src"), { recursive: true })
  await writeFile(join(repoDir, "src/obsolete.ts"), "export const obsolete = true\n", "utf8")
  runGit(repoDir, ["add", "."])
  runGit(repoDir, ["commit", "-m", "reviewed"])
  const reviewedSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()
  runGit(repoDir, ["rm", "src/obsolete.ts"])
  runGit(repoDir, ["commit", "-m", "delete-file"])
  const headSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()

  return {
    repoDir,
    reviewedSha,
    headSha,
  }
}

const SilentLoggerLayer = Logger.layer([Logger.make(() => undefined)], {
  mergeWithExisting: false,
})

export const withSilentLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SilentLoggerLayer))

export function makeOpenCodeSdkRuntime(
  prompt: (input: OpenCodeSdkPromptRequest) => Effect.Effect<OpenCodeSdkPromptResult, never>,
): OpenCodeSdkRuntime["Service"] {
  return {
    prompt,
  }
}

export const makeGitExec = (execute: GitExecShape["execute"]): GitExec["Service"] => ({
  execute,
})

export const makeGitExecLayer = (service: GitExec["Service"]) => Layer.succeed(GitExec, service)

export const makeRealGitExecLayer = () =>
  GitExecLive.pipe(Layer.provide(ProcessRunnerLive.pipe(Layer.provide(BaseRuntimeLayer))))

export function makeOpenCodeLiveLayer(sdkRuntime: OpenCodeSdkRuntime["Service"]) {
  return OpenCodeRunnerLayer.pipe(
    Layer.provide(Layer.mergeAll(BaseRuntimeLayer, Layer.succeed(OpenCodeSdkRuntime, sdkRuntime))),
  )
}

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

export const makePullRequestDiff = (overrides: Partial<PullRequestDiff> = {}): PullRequestDiff => ({
  baseRef: "abc123",
  headRef: "HEAD",
  diffText: "",
  changedFiles: [],
  changedLinesByFile: new Map<string, Set<number>>(),
  deletedLinesByFile: new Map<string, Set<number>>(),
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
