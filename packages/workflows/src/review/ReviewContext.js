import { compressChangedLines, extractHunkHeaders, splitDiffByFile } from "@open-azdo/core/git"
export const buildReviewContext = ({ metadata, reviewMode, previousReviewedCommit, pullRequestBaseRef, gitDiff }) => ({
  pullRequest: {
    title: metadata.title,
    description: metadata.description,
  },
  reviewMode,
  ...(previousReviewedCommit !== undefined ? { previousReviewedCommit } : {}),
  pullRequestBaseRef,
  baseRef: gitDiff.baseRef,
  headRef: gitDiff.headRef,
  changedFiles: splitDiffByFile(gitDiff.diffText).map((file) => ({
    path: file.path,
    changedLineRanges: compressChangedLines(gitDiff.changedLinesByFile.get(file.path) ?? new Set()),
    hunkHeaders: extractHunkHeaders(file.patch),
  })),
})
