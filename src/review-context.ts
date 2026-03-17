import { Effect } from "effect"

import { readFileExcerpt, splitDiffByFile, type GitDiff } from "./git"

export type PullRequestMetadata = {
  title: string
  description: string
}

export type ReviewContext = {
  pullRequest: {
    title: string
    description: string
  }
  changedFiles: Array<{
    path: string
    diff: string
    excerpt: string | undefined
  }>
}

export const buildReviewContext = Effect.fn("reviewContext.buildReviewContext")(function* (
  workspace: string,
  metadata: PullRequestMetadata,
  gitDiff: GitDiff,
) {
  const changedFiles: ReviewContext["changedFiles"] = []

  for (const file of splitDiffByFile(gitDiff.diffText)) {
    const excerpt = yield* readFileExcerpt(workspace, file.path)
    changedFiles.push({
      path: file.path,
      diff: file.patch,
      excerpt,
    })
  }

  return {
    pullRequest: {
      title: metadata.title,
      description: metadata.description,
    },
    changedFiles,
  } satisfies ReviewContext
})
