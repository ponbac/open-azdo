import {
  compressChangedLines,
  extractHunkHeaders,
  splitDiffByFile,
  type LineRange,
  type PullRequestDiff,
} from "@open-azdo/core/git"

export type PullRequestMetadata = {
  readonly title: string
  readonly description: string
}

export type ReviewContext = {
  readonly pullRequest: {
    readonly title: string
    readonly description: string
  }
  readonly baseRef: string
  readonly headRef: string
  readonly changedFiles: Array<{
    readonly path: string
    readonly changedLineRanges: LineRange[]
    readonly hunkHeaders: string[]
  }>
}

export const buildReviewContext = (metadata: PullRequestMetadata, gitDiff: PullRequestDiff): ReviewContext => ({
  pullRequest: {
    title: metadata.title,
    description: metadata.description,
  },
  baseRef: gitDiff.baseRef,
  headRef: gitDiff.headRef,
  changedFiles: splitDiffByFile(gitDiff.diffText).map((file) => ({
    path: file.path,
    changedLineRanges: compressChangedLines(gitDiff.changedLinesByFile.get(file.path) ?? new Set<number>()),
    hunkHeaders: extractHunkHeaders(file.patch),
  })),
})
