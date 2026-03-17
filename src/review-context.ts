import { Effect } from "effect"

import { compressChangedLines, extractHunkHeaders, splitDiffByFile, type GitDiff, type LineRange } from "./git"

export type PullRequestMetadata = {
  title: string
  description: string
}

export type ReviewContext = {
  pullRequest: {
    title: string
    description: string
  }
  baseRef: string
  headRef: string
  changedFiles: Array<{
    path: string
    changedLineRanges: LineRange[]
    hunkHeaders: string[]
  }>
}

export const buildReviewContext = Effect.fn("reviewContext.buildReviewContext")(function* (
  metadata: PullRequestMetadata,
  gitDiff: GitDiff,
) {
  const changedFiles = splitDiffByFile(gitDiff.diffText).map((file) => ({
    path: file.path,
    changedLineRanges: compressChangedLines(gitDiff.changedLinesByFile.get(file.path) ?? new Set<number>()),
    hunkHeaders: extractHunkHeaders(file.patch),
  })) satisfies ReviewContext["changedFiles"]

  return {
    pullRequest: {
      title: metadata.title,
      description: metadata.description,
    },
    baseRef: gitDiff.baseRef,
    headRef: gitDiff.headRef,
    changedFiles,
  } satisfies ReviewContext
})
