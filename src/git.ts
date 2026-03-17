import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { Effect } from "effect"

import type { ReviewConfig } from "./config"
import { GitCommandError, MissingGitHistoryError } from "./errors"
import { normalizePath } from "./review-output"

export type SpawnLike = typeof Bun.spawn

export type GitDiff = {
  baseRef: string
  headRef: string
  diffText: string
  changedFiles: string[]
  changedLinesByFile: Map<string, Set<number>>
}

export type DiffFile = {
  path: string
  patch: string
}

export const resolveGitDiff = Effect.fn("git.resolveGitDiff")(function* (
  config: ReviewConfig,
  spawn: SpawnLike = Bun.spawn,
) {
  const parents = yield* runGit(config.workspace, ["rev-list", "--parents", "-n", "1", "HEAD"], spawn)
  const hashes = parents.stdout.trim().split(/\s+/)

  let baseRef = ""
  let headRef = "HEAD"

  if (hashes.length === 3) {
    baseRef = "HEAD^1"
  } else {
    const targetRef = yield* resolveTargetRef(config, spawn)
    const mergeBase = yield* runGit(config.workspace, ["merge-base", targetRef, "HEAD"], spawn)
    baseRef = mergeBase.stdout.trim()
  }

  const diff = yield* runGit(
    config.workspace,
    ["diff", "--unified=3", "--find-renames", "--no-color", baseRef, headRef],
    spawn,
  )

  const changedFilesOutput = yield* runGit(
    config.workspace,
    ["diff", "--name-only", "--diff-filter=ACMRT", baseRef, headRef],
    spawn,
  )

  const changedFiles = changedFilesOutput.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizePath)

  return {
    baseRef,
    headRef,
    diffText: diff.stdout,
    changedFiles,
    changedLinesByFile: extractChangedLinesByFile(diff.stdout),
  } satisfies GitDiff
})

export const splitDiffByFile = (diffText: string): DiffFile[] => {
  const files: DiffFile[] = []
  const chunks = diffText.split(/^diff --git /m).filter(Boolean)

  for (const chunk of chunks) {
    const patch = `diff --git ${chunk}`
    const pathMatch = patch.match(/^\+\+\+ b\/(.+)$/m)
    if (!pathMatch?.[1]) {
      continue
    }

    files.push({
      path: normalizePath(pathMatch[1]),
      patch,
    })
  }

  return files
}

export const readFileExcerpt = Effect.fn("git.readFileExcerpt")(function* (workspace: string, filePath: string) {
  const absolutePath = join(workspace, filePath)

  return yield* Effect.tryPromise({
    try: async () => {
      const content = await readFile(absolutePath)
      if (content.byteLength > 16_000 || content.includes(0)) {
        return undefined
      }

      return content.toString("utf8")
    },
    catch: () => undefined,
  })
})

export const extractChangedLinesByFile = (diffText: string) => {
  const changedLinesByFile = new Map<string, Set<number>>()
  let currentFile: string | undefined
  let rightLine = 0

  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = normalizePath(line.slice(6))
      if (!changedLinesByFile.has(currentFile)) {
        changedLinesByFile.set(currentFile, new Set())
      }
      continue
    }

    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/)
      rightLine = match?.[1] ? Number.parseInt(match[1], 10) : 0
      continue
    }

    if (!currentFile || rightLine === 0) {
      continue
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      changedLinesByFile.get(currentFile)?.add(rightLine)
      rightLine += 1
      continue
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      continue
    }

    rightLine += 1
  }

  return changedLinesByFile
}

export const resolveTargetRef = Effect.fn("git.resolveTargetRef")(function* (
  config: ReviewConfig,
  spawn: SpawnLike = Bun.spawn,
) {
  if (!config.targetBranch) {
    return yield* new MissingGitHistoryError({
      message: "The checkout is missing PR target branch metadata.",
      remediation: "Use `checkout: self` with `fetchDepth: 0` in Azure Pipelines.",
    })
  }

  const candidates = buildTargetRefCandidates(config.targetBranch)

  for (const candidate of candidates) {
    const result = yield* runGit(config.workspace, ["rev-parse", "--verify", "--quiet", candidate], spawn, true)

    if (result.exitCode === 0) {
      return candidate
    }
  }

  return yield* new MissingGitHistoryError({
    message: `Could not resolve a local target ref for ${config.targetBranch}.`,
    remediation: "Use `checkout: self` with `fetchDepth: 0` so the target branch history is available locally.",
  })
})

export const buildTargetRefCandidates = (targetBranch: string) => {
  const normalized = targetBranch.replace(/^refs\/heads\//, "")
  return [targetBranch, `refs/remotes/origin/${normalized}`, `refs/heads/${normalized}`, normalized]
}

type GitRunResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export const runGit = Effect.fn("git.runGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  spawn: SpawnLike = Bun.spawn,
  allowFailure = false,
) {
  const result = yield* Effect.tryPromise({
    try: async () => {
      const child = spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])

      return {
        stdout,
        stderr,
        exitCode,
      } satisfies GitRunResult
    },
    catch: (error) =>
      new GitCommandError({
        message: `Failed to start git ${args.join(" ")}`,
        command: ["git", ...args],
        stderr: String(error),
        exitCode: -1,
      }),
  })

  if (result.exitCode !== 0 && !allowFailure) {
    return yield* new GitCommandError({
      message: `git ${args.join(" ")} failed`,
      command: ["git", ...args],
      stderr: result.stderr,
      exitCode: result.exitCode,
    })
  }

  return result
})
