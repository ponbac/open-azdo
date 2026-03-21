import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import * as ConfigProvider from "effect/ConfigProvider"
import { Effect, Layer, Logger, Option } from "effect"
import { AzureDevOpsClientLive } from "@open-azdo/azdo/client"
import { GitExecLive } from "@open-azdo/core/git"
import { OpenCodeRunnerLive } from "@open-azdo/core/opencode"
import { ProcessRunnerLive } from "@open-azdo/core/process-runner"
import { AppConfig, makeAppConfigLayer } from "../src/AppConfig"
const compactEnv = (env) => {
  const result = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}
export const makeBaseEnv = () => ({
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
export const makeReviewCliInput = (overrides = {}) => ({
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
export const resolveAppConfig = (cliInput, env) =>
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
const SilentLoggerLayer = Logger.layer([Logger.make(() => undefined)], {
  mergeWithExisting: false,
})
const SilentBaseRuntimeLayer = Layer.mergeAll(BunServices.layer, SilentLoggerLayer)
export const makeSilentRuntimeLayer = (cliInput) => {
  const appConfigLayer = makeAppConfigLayer(cliInput)
  const processRunnerLayer = ProcessRunnerLive.pipe(Layer.provide(SilentBaseRuntimeLayer))
  const platformLayer = Layer.mergeAll(SilentBaseRuntimeLayer, processRunnerLayer)
  const gitExecLayer = GitExecLive.pipe(Layer.provide(processRunnerLayer))
  const openCodeRunnerLayer = OpenCodeRunnerLive.pipe(Layer.provide(platformLayer))
  return Layer.mergeAll(platformLayer, appConfigLayer, gitExecLayer, AzureDevOpsClientLive, openCodeRunnerLayer)
}
export const makeFetchMock = (handler) => {
  const calls = []
  const fetchMock = async (url, init) => {
    const normalizedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url
    calls.push({ url: normalizedUrl, init })
    return handler(normalizedUrl, init)
  }
  return {
    calls,
    fetchMock,
  }
}
export const createMockFetch = (fetchMock, originalFetch) => {
  const mockedFetch = (input, init) => fetchMock(input, init)
  mockedFetch.preconnect = originalFetch.preconnect.bind(originalFetch)
  return mockedFetch
}
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
