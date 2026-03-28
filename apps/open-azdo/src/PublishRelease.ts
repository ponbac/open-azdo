import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"

export type PublishMode = "publish" | "dry-run"

type StableSemver = {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

type CommandRequest = {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  readonly stdio?: "inherit" | "pipe"
}

type CommandResult = {
  readonly stdout: string
}

export type PublishReleaseDeps = {
  readonly repoRoot: string
  readonly stdinIsTTY: boolean
  readonly stdoutIsTTY: boolean
  readonly readFile: (path: string) => Promise<string>
  readonly writeFile: (path: string, content: string) => Promise<void>
  readonly prompt: (message: string) => Promise<string>
  readonly log: (message: string) => void
  readonly runCommand: (request: CommandRequest) => Promise<CommandResult>
}

type ReleasePaths = {
  readonly packageManifestPath: string
  readonly debugPipelinePath: string
  readonly lockfilePath: string
}

type PackageManifest = Record<string, unknown> & {
  readonly name: string
  readonly version: string
}

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

/**
 * Parses plain `major.minor.patch` versions and rejects prereleases or build metadata.
 * The publish bump flow intentionally stays limited to stable npm release versions.
 */
export const parseStableSemver = (input: string): StableSemver | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(input)
  if (!match) {
    return undefined
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

const compareStableSemver = (left: StableSemver, right: StableSemver) => {
  if (left.major !== right.major) {
    return left.major - right.major
  }

  if (left.minor !== right.minor) {
    return left.minor - right.minor
  }

  return left.patch - right.patch
}

const suggestNextPatchVersion = (version: StableSemver) => `${version.major}.${version.minor}.${version.patch + 1}`

/**
 * Validates a prompted replacement version against the current package version and the
 * last npm release so the script never republishes an existing or older stable release.
 */
export const validateReplacementVersion = (
  candidate: string,
  versions: {
    readonly currentVersion: string
    readonly latestReleasedVersion: string
  },
) => {
  const trimmed = candidate.trim()
  if (trimmed.length === 0) {
    return "A new version is required."
  }

  const parsedCandidate = parseStableSemver(trimmed)
  if (!parsedCandidate) {
    return "Version must use stable semver format major.minor.patch."
  }

  if (trimmed === versions.currentVersion) {
    return "Version must differ from the current package version."
  }

  const parsedLatest = parseStableSemver(versions.latestReleasedVersion)
  if (!parsedLatest) {
    return `Latest released version "${versions.latestReleasedVersion}" is not stable semver.`
  }

  if (compareStableSemver(parsedCandidate, parsedLatest) <= 0) {
    return `Version must be greater than the last released version ${versions.latestReleasedVersion}.`
  }

  return undefined
}

const makeReleasePaths = (repoRoot: string): ReleasePaths => ({
  packageManifestPath: join(repoRoot, "apps/open-azdo/package.json"),
  debugPipelinePath: join(repoRoot, "apps/open-azdo/examples/azure-pipelines.review.debug.yml"),
  lockfilePath: join(repoRoot, "bun.lock"),
})

const makeDefaultDeps = (): PublishReleaseDeps => ({
  repoRoot: defaultRepoRoot,
  stdinIsTTY: process.stdin.isTTY ?? false,
  stdoutIsTTY: process.stdout.isTTY ?? false,
  readFile: (path) => Bun.file(path).text(),
  writeFile: async (path, content) => {
    await Bun.write(path, content)
  },
  prompt: async (message) => {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    try {
      return await prompt.question(message)
    } finally {
      prompt.close()
    }
  },
  log: (message) => {
    process.stdout.write(`${message}\n`)
  },
  runCommand: async (request) => {
    const subprocess = Bun.spawn([request.command, ...request.args], {
      ...(request.cwd ? { cwd: request.cwd } : {}),
      env: process.env,
      stdin: "ignore",
      stdout: request.stdio === "inherit" ? "inherit" : "pipe",
      stderr: request.stdio === "inherit" ? "inherit" : "pipe",
    })

    const exitCode = await subprocess.exited
    if (exitCode !== 0) {
      const stderr = request.stdio === "pipe" ? (await new Response(subprocess.stderr).text()).trim() : ""
      throw new Error(stderr.length > 0 ? stderr : `${request.command} exited with code ${exitCode}.`)
    }

    return {
      stdout: request.stdio === "pipe" ? await new Response(subprocess.stdout).text() : "",
    }
  },
})

const readPackageManifest = async (deps: PublishReleaseDeps, paths: ReleasePaths): Promise<PackageManifest> => {
  const parsed = JSON.parse(await deps.readFile(paths.packageManifestPath)) as {
    readonly name?: unknown
    readonly version?: unknown
  } & Record<string, unknown>

  const { name, version } = parsed
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`Expected name and version in ${paths.packageManifestPath}.`)
  }

  if (!parseStableSemver(version)) {
    throw new Error(`Current package version "${version}" is not stable semver.`)
  }

  return {
    ...parsed,
    name,
    version,
  }
}

const fetchLatestReleasedVersion = async (deps: PublishReleaseDeps, packageName: string) => {
  try {
    const { stdout } = await deps.runCommand({
      command: "npm",
      args: ["view", packageName, "version", "--silent"],
      cwd: deps.repoRoot,
      stdio: "pipe",
    })

    const version = stdout.trim()
    if (!parseStableSemver(version)) {
      throw new Error(`npm returned a non-stable version: "${version}".`)
    }

    return version
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to look up the latest npm release for ${packageName}: ${message}`)
  }
}

const validatePublishAuth = async (deps: PublishReleaseDeps) => {
  try {
    await deps.runCommand({
      command: "npm",
      args: ["whoami"],
      cwd: deps.repoRoot,
      stdio: "pipe",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`npm authentication failed. Run 'bunx npm login' or export a valid NPM_CONFIG_TOKEN. ${message}`)
  }
}

/**
 * Rewrites the release-managed version pins together so local publish state,
 * debug documentation, and the workspace lockfile remain aligned before publish.
 */
const rewriteReleaseFiles = async (
  deps: PublishReleaseDeps,
  paths: ReleasePaths,
  packageManifest: PackageManifest,
  nextVersion: string,
) => {
  // Preserve the full manifest so a version bump does not strip publish metadata or scripts.
  await deps.writeFile(
    paths.packageManifestPath,
    `${JSON.stringify({ ...packageManifest, version: nextVersion }, null, 2)}\n`,
  )

  const debugPipeline = await deps.readFile(paths.debugPipelinePath)
  const updatedDebugPipeline = debugPipeline.replace(/^(\s*OpenAzdoVersion:\s*)(\S+)(\s*)$/m, `$1${nextVersion}$3`)

  if (updatedDebugPipeline === debugPipeline) {
    throw new Error(`Failed to locate OpenAzdoVersion in ${paths.debugPipelinePath}.`)
  }

  await deps.writeFile(paths.debugPipelinePath, updatedDebugPipeline)
}

const runBunCommand = async (deps: PublishReleaseDeps, args: ReadonlyArray<string>) => {
  await deps.runCommand({
    command: "bun",
    args,
    cwd: deps.repoRoot,
    stdio: "inherit",
  })
}

/**
 * Prompts until the user enters a valid higher stable release version.
 * The loop keeps validation failures visible so the next prompt is actionable.
 */
const promptForReplacementVersion = async (
  deps: PublishReleaseDeps,
  versions: {
    readonly packageName: string
    readonly currentVersion: string
    readonly latestReleasedVersion: string
  },
) => {
  const parsedLatest = parseStableSemver(versions.latestReleasedVersion)
  if (!parsedLatest) {
    throw new Error(`Latest released version "${versions.latestReleasedVersion}" is not stable semver.`)
  }

  const promptMessage = [
    "",
    `Package ${versions.packageName} is already published at ${versions.latestReleasedVersion}.`,
    `Current package.json version: ${versions.currentVersion}.`,
    `Suggested next patch version: ${suggestNextPatchVersion(parsedLatest)}.`,
    "Enter a new stable version (major.minor.patch): ",
  ].join("\n")

  while (true) {
    const answer = await deps.prompt(promptMessage)
    const validationError = validateReplacementVersion(answer, {
      currentVersion: versions.currentVersion,
      latestReleasedVersion: versions.latestReleasedVersion,
    })

    if (!validationError) {
      return answer.trim()
    }

    deps.log(validationError)
  }
}

const resolvePublishVersion = async (deps: PublishReleaseDeps, paths: ReleasePaths) => {
  const packageManifest = await readPackageManifest(deps, paths)
  await validatePublishAuth(deps)
  const latestReleasedVersion = await fetchLatestReleasedVersion(deps, packageManifest.name)

  if (packageManifest.version !== latestReleasedVersion) {
    return {
      packageManifest,
      nextVersion: packageManifest.version,
      shouldRewriteFiles: false,
    } as const
  }

  if (!deps.stdinIsTTY || !deps.stdoutIsTTY) {
    throw new Error(
      `Package ${packageManifest.name} is already published at ${latestReleasedVersion}. Rerun the publish script interactively or bump the version manually before publishing.`,
    )
  }

  return {
    packageManifest,
    nextVersion: await promptForReplacementVersion(deps, {
      packageName: packageManifest.name,
      currentVersion: packageManifest.version,
      latestReleasedVersion,
    }),
    shouldRewriteFiles: true,
  } as const
}

export const runPublishRelease = async (mode: PublishMode, overrides: Partial<PublishReleaseDeps> = {}) => {
  const deps = {
    ...makeDefaultDeps(),
    ...overrides,
  } satisfies PublishReleaseDeps
  const paths = makeReleasePaths(deps.repoRoot)
  const versionPlan = await resolvePublishVersion(deps, paths)

  if (versionPlan.shouldRewriteFiles) {
    await rewriteReleaseFiles(deps, paths, versionPlan.packageManifest, versionPlan.nextVersion)

    // Refresh the workspace lockfile immediately so prepublishOnly can keep using --frozen-lockfile.
    await runBunCommand(deps, ["install", "--lockfile-only"])

    const lockfileVersion = await deps.readFile(paths.lockfilePath)
    if (!lockfileVersion.includes(versionPlan.nextVersion)) {
      throw new Error(`Lockfile sync did not capture the new version ${versionPlan.nextVersion}.`)
    }
  }

  await runBunCommand(deps, ["publish", "--cwd", "apps/open-azdo", ...(mode === "dry-run" ? ["--dry-run"] : [])])
}
