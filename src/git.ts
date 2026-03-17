import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as ServiceMap from "effect/ServiceMap"
import { Effect } from "effect"

import type { ReviewConfig } from "./config"
import { CommandExecutionError, GitCommandError, MissingGitHistoryError } from "./errors"
import { ProcessRunner } from "./process"
import { normalizePath } from "./review-output"

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

type GitRunResult = {
  stdout: string
  stderr: string
  exitCode: number
}

const toGitCommandError = (
  args: ReadonlyArray<string>,
  error: CommandExecutionError,
  message = `git ${args.join(" ")} failed`,
) =>
  new GitCommandError({
    message,
    command: ["git", ...args],
    stderr: error.stderr || error.detail,
    exitCode: error.exitCode,
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

export const buildTargetRefCandidates = (targetBranch: string) => {
  const normalized = targetBranch.replace(/^refs\/heads\//, "")
  return [targetBranch, `refs/remotes/origin/${normalized}`, `refs/heads/${normalized}`, normalized]
}

export class GitService extends ServiceMap.Service<
  GitService,
  {
    readonly resolveGitDiff: (config: ReviewConfig) => Effect.Effect<GitDiff, GitCommandError | MissingGitHistoryError>
    readonly readFileExcerpt: (workspace: string, filePath: string) => Effect.Effect<string | undefined>
    readonly runGit: (
      cwd: string,
      args: ReadonlyArray<string>,
      allowFailure?: boolean,
    ) => Effect.Effect<GitRunResult, GitCommandError>
    readonly resolveTargetRef: (config: ReviewConfig) => Effect.Effect<string, GitCommandError | MissingGitHistoryError>
  }
>()("open-azdo/GitService") {
  static readonly layer = Layer.effect(
    GitService,
    Effect.gen(function* () {
      const runner = yield* ProcessRunner
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const runGit = Effect.fn("GitService.runGit")(function* (
        cwd: string,
        args: ReadonlyArray<string>,
        allowFailure = false,
      ) {
        const result = yield* runner
          .execute({
            operation: "GitService.runGit",
            command: "git",
            args,
            cwd,
            allowNonZeroExit: true,
          })
          .pipe(Effect.mapError((error) => toGitCommandError(args, error)))

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

      const resolveTargetRef = Effect.fn("GitService.resolveTargetRef")(function* (config: ReviewConfig) {
        if (!config.targetBranch) {
          return yield* new MissingGitHistoryError({
            message: "The checkout is missing PR target branch metadata.",
            remediation: "Use `checkout: self` with `fetchDepth: 0` in Azure Pipelines.",
          })
        }

        const candidates = buildTargetRefCandidates(config.targetBranch)

        for (const candidate of candidates) {
          const result = yield* runGit(config.workspace, ["rev-parse", "--verify", "--quiet", candidate], true)

          if (result.exitCode === 0) {
            return candidate
          }
        }

        return yield* new MissingGitHistoryError({
          message: `Could not resolve a local target ref for ${config.targetBranch}.`,
          remediation: "Use `checkout: self` with `fetchDepth: 0` so the target branch history is available locally.",
        })
      })

      const resolveGitDiff = Effect.fn("GitService.resolveGitDiff")(function* (config: ReviewConfig) {
        const parents = yield* runGit(config.workspace, ["rev-list", "--parents", "-n", "1", "HEAD"])
        const hashes = parents.stdout.trim().split(/\s+/)

        let baseRef = ""
        const headRef = "HEAD"

        if (hashes.length === 3) {
          baseRef = "HEAD^1"
        } else {
          const targetRef = yield* resolveTargetRef(config)
          const mergeBase = yield* runGit(config.workspace, ["merge-base", targetRef, "HEAD"])
          baseRef = mergeBase.stdout.trim()
        }

        const diff = yield* runGit(config.workspace, [
          "diff",
          "--unified=3",
          "--find-renames",
          "--no-color",
          baseRef,
          headRef,
        ])

        const changedFilesOutput = yield* runGit(config.workspace, [
          "diff",
          "--name-only",
          "--diff-filter=ACMRT",
          baseRef,
          headRef,
        ])

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

      const readFileExcerpt = Effect.fn("GitService.readFileExcerpt")(function* (workspace: string, filePath: string) {
        const absolutePath = path.join(workspace, filePath)

        return yield* fileSystem.readFile(absolutePath).pipe(
          Effect.map((content) => {
            if (content.byteLength > 16_000 || content.some((byte) => byte === 0)) {
              return undefined
            }

            return new TextDecoder().decode(content)
          }),
          Effect.catch(() => Effect.sync((): string | undefined => undefined)),
        )
      })

      return GitService.of({
        resolveGitDiff,
        readFileExcerpt,
        runGit,
        resolveTargetRef,
      })
    }),
  )
}

export const resolveGitDiff = Effect.fn("git.resolveGitDiff")(function* (config: ReviewConfig) {
  const git = yield* GitService
  return yield* git.resolveGitDiff(config)
})

export const readFileExcerpt = Effect.fn("git.readFileExcerpt")(function* (workspace: string, filePath: string) {
  const git = yield* GitService
  return yield* git.readFileExcerpt(workspace, filePath)
})

export const resolveTargetRef = Effect.fn("git.resolveTargetRef")(function* (config: ReviewConfig) {
  const git = yield* GitService
  return yield* git.resolveTargetRef(config)
})

export const runGit = Effect.fn("git.runGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  allowFailure = false,
) {
  const git = yield* GitService
  return yield* git.runGit(cwd, args, allowFailure)
})
