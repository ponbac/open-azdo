import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Logger } from "effect"
import * as Duration from "effect/Duration"
import { BaseRuntimeLayer } from "@open-azdo/core/base-runtime"
import { GitExec, GitExecLive } from "@open-azdo/core/git"
import { OpenCodeRunnerLive } from "@open-azdo/core/opencode"
import { ProcessRunner, ProcessRunnerLive } from "@open-azdo/core/process-runner"
export const createTempDir = async (prefix) => mkdtemp(join(tmpdir(), prefix))
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
export const withSilentLogs = (effect) => effect.pipe(Effect.provide(SilentLoggerLayer))
export const makeProcessRunner = (execute) => ({
  execute,
})
export const makeGitExec = (execute) => ({
  execute,
})
export const makeGitExecLayer = (service) => Layer.succeed(GitExec, service)
export const makeRealGitExecLayer = () =>
  GitExecLive.pipe(Layer.provide(ProcessRunnerLive.pipe(Layer.provide(BaseRuntimeLayer))))
export const makeOpenCodeLiveLayer = (runner) =>
  OpenCodeRunnerLive.pipe(Layer.provide(Layer.mergeAll(BaseRuntimeLayer, Layer.succeed(ProcessRunner, runner))))
export const makeOpenCodeRunRequest = (overrides = {}) => ({
  workspace: "/tmp/workspace",
  model: "openai/gpt-5.4",
  agent: "azdo-review",
  variant: undefined,
  timeout: Duration.minutes(10),
  prompt: "Review this pull request.",
  inheritedEnv: {},
  ...overrides,
})
export const makePullRequestDiff = (overrides = {}) => ({
  baseRef: "abc123",
  headRef: "HEAD",
  diffText: "",
  changedFiles: [],
  changedLinesByFile: new Map(),
  deletedLinesByFile: new Map(),
  ...overrides,
})
const runGit = (cwd, args) => {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`)
  }
  return result.stdout
}
