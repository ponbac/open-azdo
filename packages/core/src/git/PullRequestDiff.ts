import { Duration, Effect } from "effect"

import { GitCommandError, MissingGitHistoryError } from "../errors"
import { GitExec } from "./Services/GitExec"

export type PullRequestDiff = {
  readonly baseRef: string
  readonly headRef: string
  readonly diffText: string
  /** Non-deleted paths from Git status metadata, including files without textual hunks. */
  readonly changedFiles: string[]
  /** Whole-file deletions from Git status metadata, including files with no textual hunks. */
  readonly deletedFiles: string[]
  /** Renamed destination to its previous path. */
  readonly renamedFromByFile: ReadonlyMap<string, string>
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

export type HasTargetMergeCommitInRangeInput = {
  readonly workspace: string
  readonly baseRef: string
  readonly headRef: string
  readonly currentTargetRef: string
}

/** Splits reviewable right-side file patches using the same decoded paths as the line maps. */
export const splitDiffByFile = (diffText: string): DiffFile[] => parseDiff(diffText).files

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

/** Decodes Git's C-quoted path bytes, retaining literal backslashes and filename whitespace. */
const decodeDiffPath = (headerPath: string) => {
  // Git appends a header separator tab to some unquoted names containing spaces.
  const path = headerPath.endsWith("\t") ? headerPath.slice(0, -1) : headerPath

  if (!path.startsWith('"') || !path.endsWith('"')) {
    return path
  }

  return path.slice(1, -1).replace(/\\[abfnrtv"\\]|(?:\\[0-7]{1,3})+/g, (escaped) => {
    switch (escaped) {
      case "\\a":
        return "\x07"
      case "\\b":
        return "\b"
      case "\\f":
        return "\f"
      case "\\n":
        return "\n"
      case "\\r":
        return "\r"
      case "\\t":
        return "\t"
      case "\\v":
        return "\v"
      case '\\"':
        return '"'
      case "\\\\":
        return "\\"
      default: {
        // Non-ASCII names use octal UTF-8 bytes, so decode the complete byte run together.
        const bytes = Array.from(escaped.matchAll(/\\[0-7]{1,3}/g), (match) => Number.parseInt(match[0].slice(1), 8))

        return new TextDecoder().decode(Uint8Array.from(bytes))
      }
    }
  })
}

const parseDiffPath = (line: string, side: "a" | "b") => {
  const path = decodeDiffPath(line.slice(4))
  const prefix = `${side}/`

  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined
}

type DiffHunk = {
  leftLine: number
  rightLine: number
  leftRemaining: number
  rightRemaining: number
}

/** Reads both line origins and counts; omitted counts mean one line, while explicit zero stays zero. */
const parseDiffHunk = (line: string): DiffHunk | undefined => {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)

  if (match?.[1] === undefined || match[3] === undefined) {
    return undefined
  }

  return {
    leftLine: Number.parseInt(match[1], 10),
    rightLine: Number.parseInt(match[3], 10),
    leftRemaining: Number.parseInt(match[2] ?? "1", 10),
    rightRemaining: Number.parseInt(match[4] ?? "1", 10),
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

/** Parses file headers outside counted hunks so source text cannot replace a file's identity. */
const parseDiff = (diffText: string) => {
  const files: DiffFile[] = []
  const changedLinesByFile = new Map<string, Set<number>>()
  const deletedLinesByFile = new Map<string, Set<number>>()

  // Git records are LF-delimited; multiline ^ also matches CR and Unicode characters inside source text.
  for (const chunk of diffText.split(/(?<![^\n])diff --git /).filter(Boolean)) {
    const patch = `diff --git ${chunk}`
    let leftPath: string | undefined
    let rightPath: string | undefined
    let hunk: DiffHunk | undefined

    for (const line of patch.split("\n")) {
      // No-newline markers describe the preceding line and consume neither side's count.
      if (line.startsWith("\\")) {
        continue
      }

      if (hunk !== undefined) {
        if (line.startsWith("+")) {
          if (rightPath !== undefined) {
            getOrCreateLineSet(changedLinesByFile, rightPath).add(hunk.rightLine)
          }

          hunk.rightLine += 1
          hunk.rightRemaining -= 1
        } else if (line.startsWith("-")) {
          if (leftPath !== undefined) {
            getOrCreateLineSet(deletedLinesByFile, leftPath).add(hunk.leftLine)
          }

          hunk.leftLine += 1
          hunk.leftRemaining -= 1
        } else if (line.startsWith(" ")) {
          hunk.leftLine += 1
          hunk.rightLine += 1
          hunk.leftRemaining -= 1
          hunk.rightRemaining -= 1
        }

        if (hunk.leftRemaining === 0 && hunk.rightRemaining === 0) {
          hunk = undefined
        }

        continue
      }

      if (line.startsWith("--- ")) {
        leftPath = parseDiffPath(line, "a")
      } else if (line.startsWith("+++ ")) {
        rightPath = parseDiffPath(line, "b")
      } else {
        hunk = parseDiffHunk(line)
      }
    }

    // Deleted files have no reviewable right-side patch, but retain their removed-line map.
    if (rightPath !== undefined) {
      files.push({ path: rightPath, patch })
    }
  }

  return {
    files,
    changedLinesByFile,
    deletedLinesByFile,
  }
}

export const extractChangedLinesByFile = (diffText: string): Map<string, Set<number>> =>
  parseDiff(diffText).changedLinesByFile

/**
 * Prefer the fetched remote-tracking ref over local branch names so PR workspaces do not
 * accidentally treat a local `main` branch as the live target tip.
 */
export const buildTargetRefCandidates = (targetBranch: string) => {
  const normalized = targetBranch.replace(/^refs\/heads\//, "")

  return [`refs/remotes/origin/${normalized}`, targetBranch, `refs/heads/${normalized}`, normalized]
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

const resolveCommitRef = (workspace: string, operation: string, ref: string) =>
  runGit(workspace, operation, ["rev-parse", "--verify", `${ref}^{commit}`]).pipe(
    Effect.map((result) => result.stdout.trim()),
  )

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

/**
 * Detect whether a first-parent follow-up range includes a merge that pulled target-branch
 * history into the PR branch, which would contaminate a direct source-commit diff with
 * target-only changes that Azure DevOps would not consider part of the PR scope.
 */
export const hasTargetMergeCommitInRange = ({
  workspace,
  baseRef,
  headRef,
  currentTargetRef,
}: HasTargetMergeCommitInRangeInput) =>
  Effect.gen(function* () {
    const history = yield* runGit(workspace, "Git.hasTargetMergeCommitInRange.revList", [
      "rev-list",
      "--first-parent",
      "--parents",
      `${baseRef}..${headRef}`,
    ])

    for (const line of history.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      const [, , ...mergedParents] = line.split(/\s+/)

      if (mergedParents.length === 0) {
        continue
      }

      // Any non-first parent that is already on the current PR base indicates the source branch
      // merged target history between reviews, so a commit-to-commit follow-up diff is no longer safe.
      for (const mergedParent of mergedParents) {
        if (
          yield* isAncestor({
            workspace,
            ancestorRef: mergedParent,
            headRef: currentTargetRef,
          })
        ) {
          return true
        }
      }
    }

    return false
  })

/** Decodes Git's NUL status records once; renames consume two exact path fields. */
const parseDiffStatus = Effect.fn("Git.parseDiffStatus")(function* (output: string, workspace: string) {
  const fields = output.split("\0")
  const changedFiles: string[] = []
  const deletedFiles: string[] = []
  const renamedFromByFile = new Map<string, string>()

  const invalidMetadata = new GitCommandError({
    operation: "Git.resolveDiffRange.fileStatus",
    command: "git diff --name-status -z --find-renames",
    cwd: workspace,
    detail: "Git returned malformed NUL-delimited file-status metadata.",
  })

  if (fields.pop() !== "") {
    return yield* invalidMetadata
  }

  let index = 0

  while (index < fields.length) {
    const status = fields[index]
    const sourcePath = fields[index + 1]

    if (
      status === undefined ||
      !/^(?:[ADMTUXB]|[RM]\d{1,3})$/.test(status) ||
      sourcePath === undefined ||
      sourcePath === ""
    ) {
      return yield* invalidMetadata
    }

    index += 2

    if (status.startsWith("R")) {
      const destinationPath = fields[index]

      if (destinationPath === undefined || destinationPath === "") {
        return yield* invalidMetadata
      }

      index += 1
      changedFiles.push(destinationPath)

      renamedFromByFile.set(destinationPath, sourcePath)
    } else if (status === "D") {
      deletedFiles.push(sourcePath)
    } else {
      changedFiles.push(sourcePath)
    }
  }

  return { changedFiles, deletedFiles, renamedFromByFile }
})

/** Collects bounded patch data and authoritative file identities for one commit range. */
export const resolveDiffRange = ({ workspace, baseRef, headRef }: ResolveDiffRangeInput) =>
  Effect.gen(function* () {
    const git = yield* GitExec

    // Patch and path metadata grow with the review range; short ref/history commands retain their defaults.
    const diffOptions = {
      cwd: workspace,
      maxOutputBytes: 64 * 1024 * 1024,
      timeout: Duration.minutes(2),
    }

    const diff = yield* git.execute({
      ...diffOptions,
      operation: "Git.resolveDiffRange.diff",
      args: [
        "-c",
        "core.quotePath=false",
        "-c",
        "diff.suppressBlankEmpty=false",
        "diff",
        // The parser owns canonical a/b headers independently of the checkout's diff preferences.
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=3",
        "--find-renames",
        "--no-color",
        baseRef,
        headRef,
      ],
    })

    const fileStatus = yield* git.execute({
      ...diffOptions,
      operation: "Git.resolveDiffRange.fileStatus",
      args: ["diff", "--name-status", "-z", "--find-renames", baseRef, headRef],
    })

    const { changedFiles, deletedFiles, renamedFromByFile } = yield* parseDiffStatus(fileStatus.stdout, workspace)

    const { changedLinesByFile, deletedLinesByFile } = parseDiff(diff.stdout)

    return {
      baseRef,
      headRef,
      diffText: diff.stdout,
      changedFiles,
      deletedFiles,
      renamedFromByFile,
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

/**
 * Resolve the current pull-request diff against the commit that actually backs the target branch.
 * This covers both synthetic Azure Pipelines merge checkouts and source-branch merge commits that
 * have already merged the target branch locally.
 */
export const resolvePullRequestDiff = (input: ResolvePullRequestDiffInput) =>
  Effect.gen(function* () {
    const targetRef = yield* resolveTargetRef(input)
    const targetCommit = yield* resolveCommitRef(input.workspace, "Git.resolvePullRequestDiff.targetCommit", targetRef)

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
    const matchingTargetParent = hashes.slice(1).find((hash) => hash === targetCommit)

    if (matchingTargetParent) {
      // The current HEAD is a merge commit. Match the target tip to the correct parent instead of
      // assuming HEAD^1 is always the synthetic merge base.
      baseRef = matchingTargetParent
    } else {
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
