import { Effect } from "effect"

import { MissingGitHistoryError } from "../errors"
import { GitExec } from "./Services/GitExec"
import { normalizePath } from "../review/ReviewOutput"

export type PullRequestDiff = {
  readonly baseRef: string
  readonly headRef: string
  readonly diffText: string
  readonly changedFiles: string[]
  readonly changedLinesByFile: Map<string, Set<number>>
}

export type DiffFile = {
  readonly path: string
  readonly patch: string
}

export type LineRange = {
  readonly start: number
  readonly end: number
}

export type ResolvePullRequestDiffInput = {
  readonly workspace: string
  readonly targetBranch: string | undefined
}

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

export const compressChangedLines = (changedLines: ReadonlySet<number>): LineRange[] => {
  const sortedLines = [...changedLines].sort((left, right) => left - right)
  const [firstLine, ...rest] = sortedLines

  if (firstLine === undefined) {
    return []
  }

  const ranges: LineRange[] = []
  let start = firstLine
  let previous = firstLine

  for (const line of rest) {
    if (line === previous + 1) {
      previous = line
      continue
    }

    ranges.push({ start, end: previous })
    start = line
    previous = line
  }

  ranges.push({ start, end: previous })
  return ranges
}

export const extractHunkHeaders = (patch: string) =>
  patch
    .split("\n")
    .filter((line) => line.startsWith("@@"))
    .map((line) => line.trim())

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

const runGit = (workspace: string, operation: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
  Effect.gen(function* () {
    const git = yield* GitExec
    return yield* git.execute({
      operation,
      cwd: workspace,
      args,
      allowNonZeroExit,
    })
  })

export const resolveTargetRef = ({ workspace, targetBranch }: ResolvePullRequestDiffInput) =>
  Effect.gen(function* () {
    if (!targetBranch) {
      return yield* new MissingGitHistoryError({
        message: "The checkout is missing PR target branch metadata.",
        remediation: "Use `checkout: self` with `fetchDepth: 0` in Azure Pipelines.",
      })
    }

    const candidates = buildTargetRefCandidates(targetBranch)

    for (const candidate of candidates) {
      const result = yield* runGit(
        workspace,
        "Git.resolveTargetRef",
        ["rev-parse", "--verify", "--quiet", candidate],
        true,
      )

      if (result.exitCode === 0) {
        return candidate
      }
    }

    return yield* new MissingGitHistoryError({
      message: `Could not resolve a local target ref for ${targetBranch}.`,
      remediation: "Use `checkout: self` with `fetchDepth: 0` so the target branch history is available locally.",
    })
  })

export const resolvePullRequestDiff = (input: ResolvePullRequestDiffInput) =>
  Effect.gen(function* () {
    const parents = yield* runGit(input.workspace, "Git.resolvePullRequestDiff.revList", [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    ])
    const hashes = parents.stdout.trim().split(/\s+/)

    let baseRef = ""
    const headRef = "HEAD"

    if (hashes.length === 3) {
      baseRef = "HEAD^1"
    } else {
      const targetRef = yield* resolveTargetRef(input)
      const mergeBase = yield* runGit(input.workspace, "Git.resolvePullRequestDiff.mergeBase", [
        "merge-base",
        targetRef,
        "HEAD",
      ])
      baseRef = mergeBase.stdout.trim()
    }

    const diff = yield* runGit(input.workspace, "Git.resolvePullRequestDiff.diff", [
      "diff",
      "--unified=3",
      "--find-renames",
      "--no-color",
      baseRef,
      headRef,
    ])

    const changedFilesOutput = yield* runGit(input.workspace, "Git.resolvePullRequestDiff.changedFiles", [
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
    } satisfies PullRequestDiff
  })
