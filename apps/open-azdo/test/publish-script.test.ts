import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runPublishRelease } from "../src/PublishRelease"

type TestSetup = {
  readonly repoRoot: string
  readonly packageManifestPath: string
  readonly debugPipelinePath: string
  readonly pnpmPipelinePath: string
  readonly lockfilePath: string
}

type CommandCall = {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  readonly stdio?: "inherit" | "pipe"
}

type TestDeps = Parameters<typeof runPublishRelease>[1]

const createTestRepo = async (): Promise<TestSetup> => {
  const repoRoot = await mkdtemp(join(tmpdir(), "open-azdo-publish-"))
  const appDir = join(repoRoot, "apps/open-azdo")
  const examplesDir = join(appDir, "examples")

  await mkdir(examplesDir, { recursive: true })

  const packageManifestPath = join(appDir, "package.json")
  const debugPipelinePath = join(examplesDir, "azure-pipelines.review.debug.yml")
  const pnpmPipelinePath = join(examplesDir, "azure-pipelines.review.pnpm.yml")
  const lockfilePath = join(repoRoot, "bun.lock")

  await writeFile(
    packageManifestPath,
    `${JSON.stringify(
      {
        name: "open-azdo",
        version: "0.2.9",
        description: "Secure Azure DevOps pull request review CLI powered by OpenCode",
        files: ["dist", "README.md", "SECURITY.md", "examples"],
        scripts: {
          build: "bun run build.ts",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  await writeFile(debugPipelinePath, ["variables:", "  OpenAzdoVersion: 0.2.9", "steps: []", ""].join("\n"), "utf8")
  await writeFile(pnpmPipelinePath, ["variables:", "  OpenAzdoVersion: 0.2.9", "steps: []", ""].join("\n"), "utf8")
  await writeFile(lockfilePath, 'apps/open-azdo version = "0.2.9"\n', "utf8")

  return {
    repoRoot,
    packageManifestPath,
    debugPipelinePath,
    pnpmPipelinePath,
    lockfilePath,
  }
}

const makeRunner = (
  repo: TestSetup,
  options: {
    readonly latestReleasedVersion: string
    readonly commandCalls: CommandCall[]
  },
) => {
  return async (request: CommandCall) => {
    options.commandCalls.push(request)

    if (request.command === "npm" && request.args[0] === "whoami") {
      return {
        stdout: "ponbac\n",
      }
    }

    if (request.command === "npm") {
      expect(request.args).toEqual(["view", "open-azdo", "version", "--silent"])
      return {
        stdout: `${options.latestReleasedVersion}\n`,
      }
    }

    if (request.command === "bun" && request.args[0] === "install") {
      const packageManifest = JSON.parse(await readFile(repo.packageManifestPath, "utf8")) as { version: string }
      await writeFile(repo.lockfilePath, `apps/open-azdo version = "${packageManifest.version}"\n`, "utf8")
      return {
        stdout: "",
      }
    }

    if (request.command === "bun" && request.args[0] === "publish") {
      return {
        stdout: "",
      }
    }

    throw new Error(`Unexpected command ${request.command} ${request.args.join(" ")}`)
  }
}

const readVersionState = async (repo: TestSetup) => ({
  packageManifest: await readFile(repo.packageManifestPath, "utf8"),
  debugPipeline: await readFile(repo.debugPipelinePath, "utf8"),
  pnpmPipeline: await readFile(repo.pnpmPipelinePath, "utf8"),
  lockfile: await readFile(repo.lockfilePath, "utf8"),
})

const makeTestDeps = (
  repo: TestSetup,
  options: {
    readonly commandCalls: CommandCall[]
    readonly latestReleasedVersion: string
    readonly prompt?: () => Promise<string>
    readonly log?: (message: string) => void
    readonly stdinIsTTY?: boolean
    readonly stdoutIsTTY?: boolean
  },
): TestDeps => ({
  repoRoot: repo.repoRoot,
  stdinIsTTY: options.stdinIsTTY ?? true,
  stdoutIsTTY: options.stdoutIsTTY ?? true,
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, content) => writeFile(path, content, "utf8"),
  prompt: options.prompt ?? (async () => "0.2.10"),
  log: options.log ?? (() => undefined),
  runCommand: makeRunner(repo, {
    latestReleasedVersion: options.latestReleasedVersion,
    commandCalls: options.commandCalls,
  }),
})

describe("publish release script", () => {
  test("fails clearly when the published version matches in a non-interactive run", async () => {
    const repo = await createTestRepo()
    const commandCalls: CommandCall[] = []
    const initialState = await readVersionState(repo)

    let failure: unknown

    try {
      await runPublishRelease(
        "publish",
        makeTestDeps(repo, {
          commandCalls,
          latestReleasedVersion: "0.2.9",
          stdinIsTTY: false,
          stdoutIsTTY: false,
        }),
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("already published at 0.2.9")

    expect(commandCalls).toEqual([
      {
        command: "npm",
        args: ["whoami"],
        cwd: repo.repoRoot,
        stdio: "pipe",
      },
      {
        command: "npm",
        args: ["view", "open-azdo", "version", "--silent"],
        cwd: repo.repoRoot,
        stdio: "pipe",
      },
    ])
    expect(await readVersionState(repo)).toEqual(initialState)
  })

  test("prompts for a higher version, rewrites tracked files, syncs the lockfile, and dry-runs publish", async () => {
    const repo = await createTestRepo()
    const commandCalls: CommandCall[] = []
    let promptCount = 0

    await runPublishRelease(
      "dry-run",
      makeTestDeps(repo, {
        commandCalls,
        latestReleasedVersion: "0.2.9",
        prompt: async () => {
          promptCount += 1
          return "0.2.10"
        },
      }),
    )

    expect(promptCount).toBe(1)

    const packageManifest = JSON.parse(await readFile(repo.packageManifestPath, "utf8")) as {
      version: string
      description: string
      files: string[]
      scripts: {
        build: string
      }
    }
    expect(packageManifest.version).toBe("0.2.10")
    expect(packageManifest.description).toBe("Secure Azure DevOps pull request review CLI powered by OpenCode")
    expect(packageManifest.files).toEqual(["dist", "README.md", "SECURITY.md", "examples"])
    expect(packageManifest.scripts.build).toBe("bun run build.ts")
    expect(await readFile(repo.debugPipelinePath, "utf8")).toContain("OpenAzdoVersion: 0.2.10")
    expect(await readFile(repo.pnpmPipelinePath, "utf8")).toContain("OpenAzdoVersion: 0.2.10")
    expect(await readFile(repo.lockfilePath, "utf8")).toContain('apps/open-azdo version = "0.2.10"')
    expect(commandCalls).toEqual([
      {
        command: "npm",
        args: ["whoami"],
        cwd: repo.repoRoot,
        stdio: "pipe",
      },
      {
        command: "npm",
        args: ["view", "open-azdo", "version", "--silent"],
        cwd: repo.repoRoot,
        stdio: "pipe",
      },
      {
        command: "bun",
        args: ["install", "--lockfile-only"],
        cwd: repo.repoRoot,
        stdio: "inherit",
      },
      {
        command: "bun",
        args: ["publish", "--cwd", "apps/open-azdo", "--dry-run"],
        cwd: repo.repoRoot,
        stdio: "inherit",
      },
    ])
  })

  test("publishes directly without prompting when the local version is newer than npm", async () => {
    const repo = await createTestRepo()
    const commandCalls: CommandCall[] = []
    let promptCount = 0
    const initialState = await readVersionState(repo)

    await runPublishRelease(
      "publish",
      makeTestDeps(repo, {
        commandCalls,
        latestReleasedVersion: "0.2.8",
        prompt: async () => {
          promptCount += 1
          return "0.2.10"
        },
      }),
    )

    expect(promptCount).toBe(0)
    expect(commandCalls).toEqual([
      {
        command: "npm",
        args: ["whoami"],
        cwd: repo.repoRoot,
        stdio: "pipe",
      },
      {
        command: "npm",
        args: ["view", "open-azdo", "version", "--silent"],
        cwd: repo.repoRoot,
        stdio: "pipe",
      },
      {
        command: "bun",
        args: ["publish", "--cwd", "apps/open-azdo"],
        cwd: repo.repoRoot,
        stdio: "inherit",
      },
    ])
    expect(await readVersionState(repo)).toEqual(initialState)
  })

  test("keeps prompting until a valid higher stable version is provided", async () => {
    const repo = await createTestRepo()
    const commandCalls: CommandCall[] = []
    const logs: string[] = []
    const answers = ["", "0.2.9", "0.2.8", "0.2.x", "0.2.10"]
    let promptCount = 0

    await runPublishRelease(
      "publish",
      makeTestDeps(repo, {
        commandCalls,
        latestReleasedVersion: "0.2.9",
        prompt: async () => {
          const answer = answers[promptCount]
          promptCount += 1

          if (answer === undefined) {
            throw new Error("Prompt was called more times than expected.")
          }

          return answer
        },
        log: (message) => {
          logs.push(message)
        },
      }),
    )

    expect(promptCount).toBe(5)
    expect(logs).toEqual([
      "A new version is required.",
      "Version must differ from the current package version.",
      "Version must be greater than the last released version 0.2.9.",
      "Version must use stable semver format major.minor.patch.",
    ])
    expect(commandCalls[0]).toEqual({
      command: "npm",
      args: ["whoami"],
      cwd: repo.repoRoot,
      stdio: "pipe",
    })
    expect(commandCalls.at(-1)).toEqual({
      command: "bun",
      args: ["publish", "--cwd", "apps/open-azdo"],
      cwd: repo.repoRoot,
      stdio: "inherit",
    })
    expect(await readFile(repo.debugPipelinePath, "utf8")).toContain("OpenAzdoVersion: 0.2.10")
    expect(await readFile(repo.pnpmPipelinePath, "utf8")).toContain("OpenAzdoVersion: 0.2.10")
  })

  test("fails before prompting when npm authentication is invalid", async () => {
    const repo = await createTestRepo()
    const commandCalls: CommandCall[] = []
    const initialState = await readVersionState(repo)
    let promptCount = 0

    let failure: unknown

    try {
      await runPublishRelease("publish", {
        ...makeTestDeps(repo, {
          commandCalls,
          latestReleasedVersion: "0.2.9",
          prompt: async () => {
            promptCount += 1
            return "0.2.10"
          },
        }),
        runCommand: async (request) => {
          commandCalls.push(request)

          if (request.command === "npm" && request.args[0] === "whoami") {
            throw new Error("401 Unauthorized")
          }

          throw new Error(`Unexpected command ${request.command} ${request.args.join(" ")}`)
        },
      })
    } catch (error) {
      failure = error
    }

    expect(promptCount).toBe(0)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("npm authentication failed")
    expect(commandCalls).toEqual([
      {
        command: "npm",
        args: ["whoami"],
        cwd: repo.repoRoot,
        stdio: "pipe",
      },
    ])
    expect(await readVersionState(repo)).toEqual(initialState)
  })

  test("fails clearly when a managed example is missing the release version placeholder", async () => {
    const repo = await createTestRepo()
    const commandCalls: CommandCall[] = []

    await writeFile(repo.pnpmPipelinePath, ["variables:", "steps: []", ""].join("\n"), "utf8")
    const stateBeforePublish = await readVersionState(repo)

    let failure: unknown

    try {
      await runPublishRelease(
        "publish",
        makeTestDeps(repo, {
          commandCalls,
          latestReleasedVersion: "0.2.9",
          prompt: async () => "0.2.10",
        }),
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(repo.pnpmPipelinePath)
    expect((failure as Error).message).toContain("Failed to locate OpenAzdoVersion")
    expect(commandCalls).toEqual([
      {
        command: "npm",
        args: ["whoami"],
        cwd: repo.repoRoot,
        stdio: "pipe",
      },
      {
        command: "npm",
        args: ["view", "open-azdo", "version", "--silent"],
        cwd: repo.repoRoot,
        stdio: "pipe",
      },
    ])
    expect(await readVersionState(repo)).toEqual(stateBeforePublish)
    expect(await readFile(repo.lockfilePath, "utf8")).toContain('apps/open-azdo version = "0.2.9"')
  })
})
