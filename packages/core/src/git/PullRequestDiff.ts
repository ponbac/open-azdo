import { Effect } from "effect"

import { MissingGitHistoryError } from "../errors"
import { normalizePath } from "../paths"
import { GitExec } from "./Services/GitExec"

export type PullRequestDiff = {
  readonly baseRef: string
  readonly headRef: string
  readonly diffText: string
  readonly changedFiles: string[]
  readonly changedLinesByFile: Map<string, Set<number>>
  readonly deletedLinesByFile: Map<string, Set<number>>
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

export type ResolveDiffRangeInput = {
  readonly workspace: string
  readonly baseRef: string
  readonly headRef: string
}

export type ResolveReviewedSourceCommitInput = {
  readonly workspace: string
  readonly sourceCommitId: string | undefined
}

export type IsAncestorInput = {
  readonly workspace: string
  readonly ancestorRef: string
  readonly headRef: string
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

const parseDiffPath = (line: string, prefix: "--- a/" | "+++ b/") =>
  line.startsWith(prefix) ? normalizePath(line.slice(prefix.length)) : undefined

const parseHunkStartLines = (line: string) => {
  const match = line.match(/-(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/)
  return {
    leftLine: match?.[1] ? Number.parseInt(match[1], 10) : 0,
    rightLine: match?.[2] ? Number.parseInt(match[2], 10) : 0,
  }
}

const getOrCreateLineSet = (map: Map<string, Set<number>>, filePath: string) => {
  const existingLines = map.get(filePath)
  if (existingLines) {
    return existingLines
  }

  const lines = new Set<number>()
  map.set(filePath, lines)
  return lines
}

const extractDiffLineMaps = (diffText: string) => {
  const changedLinesByFile = new Map<string, Set<number>>()
  const deletedLinesByFile = new Map<string, Set<number>>()
  let currentRightFile: string | undefined
  let currentLeftFile: string | undefined
  let leftLine = 0
  let rightLine = 0

  for (const line of diffText.split("\n")) {
    if (line.startsWith("--- ")) {
      currentLeftFile = parseDiffPath(line, "--- a/")
      continue
    }

    if (line.startsWith("+++ ")) {
      currentRightFile = parseDiffPath(line, "+++ b/")
      continue
    }

    if (line.startsWith("@@")) {
      const nextLines = parseHunkStartLines(line)
      leftLine = nextLines.leftLine
      rightLine = nextLines.rightLine
      continue
    }

    if (leftLine === 0 && rightLine === 0) {
      continue
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (currentRightFile) {
        getOrCreateLineSet(changedLinesByFile, currentRightFile).add(rightLine)
      }
      rightLine += 1
      continue
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      if (currentLeftFile) {
        getOrCreateLineSet(deletedLinesByFile, currentLeftFile).add(leftLine)
      }
      leftLine += 1
      continue
    }

    leftLine += 1
    rightLine += 1
  }

  return {
    changedLinesByFile,
    deletedLinesByFile,
  }
}

export const extractChangedLinesByFile = (diffText: string): Map<string, Set<number>> =>
  extractDiffLineMaps(diffText).changedLinesByFile

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

const resolveHeadReviewedSourceCommitCandidate = (workspace: string) =>
  runGit(workspace, "Git.resolveReviewedSourceCommit.revList", ["rev-list", "--parents", "-n", "1", "HEAD"]).pipe(
    Effect.map((result) => {
      const hashes = result.stdout.trim().split(/\s+/)
      return hashes.length === 3 ? "HEAD^2" : "HEAD"
    }),
  )

export const resolveReviewedSourceCommit = ({ workspace, sourceCommitId }: ResolveReviewedSourceCommitInput) =>
  Effect.gen(function* () {
    const fallbackCandidate = yield* resolveHeadReviewedSourceCommitCandidate(workspace)

    let candidate = fallbackCandidate

    if (sourceCommitId !== undefined) {
      const explicitCandidate = yield* runGit(
        workspace,
        "Git.resolveReviewedSourceCommit.verifyExplicit",
        ["rev-parse", "--verify", `${sourceCommitId}^{commit}`],
        true,
      )
      candidate = explicitCandidate.exitCode === 0 ? sourceCommitId : fallbackCandidate
    }

    const resolved = yield* runGit(workspace, "Git.resolveReviewedSourceCommit.revParse", [
      "rev-parse",
      "--verify",
      candidate,
    ]).pipe(
      Effect.mapError(
        () =>
          new MissingGitHistoryError({
            message: `Could not resolve reviewed source commit ${candidate}.`,
            remediation:
              "Use `checkout: self` with `fetchDepth: 0` so the pull request source commit is available locally.",
          }),
      ),
    )

    return resolved.stdout.trim()
  })

export const isAncestor = ({ workspace, ancestorRef, headRef }: IsAncestorInput) =>
  Effect.gen(function* () {
    const result = yield* runGit(
      workspace,
      "Git.isAncestor",
      ["merge-base", "--is-ancestor", ancestorRef, headRef],
      true,
    )

    if (result.exitCode === 0) {
      return true
    }

    if (result.exitCode === 1) {
      return false
    }

    return yield* new MissingGitHistoryError({
      message: `Could not determine whether ${ancestorRef} is an ancestor of ${headRef}.`,
      remediation: "Use `checkout: self` with `fetchDepth: 0` so the relevant commit history is available locally.",
    })
  })

export const resolveDiffRange = ({ workspace, baseRef, headRef }: ResolveDiffRangeInput) =>
  Effect.gen(function* () {
    const diff = yield* runGit(workspace, "Git.resolveDiffRange.diff", [
      "diff",
      "--unified=3",
      "--find-renames",
      "--no-color",
      baseRef,
      headRef,
    ])

    const changedFilesOutput = yield* runGit(workspace, "Git.resolveDiffRange.changedFiles", [
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

    const { changedLinesByFile, deletedLinesByFile } = extractDiffLineMaps(diff.stdout)

    return {
      baseRef,
      headRef,
      diffText: diff.stdout,
      changedFiles,
      changedLinesByFile,
      deletedLinesByFile,
    } satisfies PullRequestDiff
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

    return yield* resolveDiffRange({
      workspace: input.workspace,
      baseRef,
      headRef,
    })
  })
