import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BunServices } from "@effect/platform-bun"
import * as ConfigProvider from "effect/ConfigProvider"
import { Effect, Layer, Logger, Option } from "effect"

import { AzureDevOpsClientLive } from "@open-azdo/azdo/client"
import { GitExecLive } from "@open-azdo/core/git"
import { OpenCodeRunner } from "@open-azdo/core/opencode"
import { ProcessRunnerLive } from "@open-azdo/core/process-runner"

import { AppConfig, AppConfigLive, ReviewCommandInput, type ReviewCliInput } from "../src/AppConfig"

const compactEnv = (env: Record<string, string | undefined>) => {
  const result: Record<string, string> = {}

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
      AppConfigLive.pipe(
        Layer.provide(Layer.succeed(ReviewCommandInput, cliInput)),
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

/** Build an OpenCode test service with an explicitly supplied run behavior. */
export const makeOpenCodeRunner = (run: OpenCodeRunner["Service"]["run"]): OpenCodeRunner["Service"] => ({
  run,
})

/** Use real platform, Git, and Azure adapters with silent logs and the supplied OpenCode service. */
export const makeSilentRuntimeLayer = (
  cliInput: ReviewCliInput,
  options: {
    readonly openCodeRunner: OpenCodeRunner["Service"]
  },
) => {
  const appConfigLayer = AppConfigLive.pipe(Layer.provide(Layer.succeed(ReviewCommandInput, cliInput)))
  const processRunnerLayer = ProcessRunnerLive.pipe(Layer.provide(SilentBaseRuntimeLayer))
  const platformLayer = Layer.mergeAll(SilentBaseRuntimeLayer, processRunnerLayer)
  const gitExecLayer = GitExecLive.pipe(Layer.provide(processRunnerLayer))

  const openCodeRunnerLayer = Layer.succeed(OpenCodeRunner, options.openCodeRunner)

  return Layer.mergeAll(platformLayer, appConfigLayer, gitExecLayer, AzureDevOpsClientLive, openCodeRunnerLayer)
}

export type FetchCall = {
  readonly url: string
  readonly init: RequestInit | undefined
}

export type FetchLike = typeof globalThis.fetch

/** Normalize the request through the Fetch API so tests observe serialized transport bytes. */
const normalizeFetchCall = async (url: string | URL | Request, init?: RequestInit) => {
  const normalizedUrl = url instanceof Request ? url.url : url.toString()

  const body =
    init?.body !== undefined
      ? await new Response(init.body).text()
      : url instanceof Request
        ? await url.clone().text()
        : undefined

  if (url instanceof Request) {
    const requestInit: RequestInit = {
      method: init?.method ?? url.method,
      headers: init?.headers ?? url.headers,
      signal: init?.signal ?? url.signal,
    }

    if (body !== undefined) {
      requestInit.body = body
    }

    return { url: normalizedUrl, init: requestInit }
  }

  if (init === undefined) {
    return { url: normalizedUrl, init: undefined }
  }

  const requestInit: RequestInit = { ...init }

  if (body !== undefined) {
    requestInit.body = body
  }

  return { url: normalizedUrl, init: requestInit }
}

export const makeFetchMock = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: FetchCall[] = []

  const fetchRequest = async (url: string | URL | Request, init?: RequestInit) => {
    const normalizedCall = await normalizeFetchCall(url, init)
    calls.push(normalizedCall)

    return handler(normalizedCall.url, normalizedCall.init)
  }

  // Bun includes preconnect on fetch; reject it explicitly rather than claiming to emulate a connection pool.
  const fetchMock: FetchLike = Object.assign(fetchRequest, {
    preconnect: () => {
      throw new Error("The mock transport does not support preconnect.")
    },
  })

  return { calls, fetchMock }
}

export const createTempDir = async (prefix: string) => mkdtemp(join(tmpdir(), prefix))

export const createFixtureRepo = async (featureContent = "export const value = 2\nexport const next = 3\n") => {
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
  await writeFile(join(repoDir, "src/example.ts"), featureContent, "utf8")
  runGit(repoDir, ["commit", "-am", "feature"])
  const featureSha = runGit(repoDir, ["rev-parse", "HEAD"]).trim()

  return {
    featureSha,
    mainSha,
    repoDir,
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
