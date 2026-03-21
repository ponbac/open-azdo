import { type LineRange, type PullRequestDiff } from "@open-azdo/core/git"
export type PullRequestMetadata = {
  readonly title: string
  readonly description: string
}
export type ReviewMode = "full" | "follow-up" | "skipped"
export type ReviewContext = {
  readonly pullRequest: {
    readonly title: string
    readonly description: string
  }
  readonly reviewMode: ReviewMode
  readonly previousReviewedCommit?: string
  readonly pullRequestBaseRef: string
  readonly baseRef: string
  readonly headRef: string
  readonly changedFiles: Array<{
    readonly path: string
    readonly changedLineRanges: LineRange[]
    readonly hunkHeaders: string[]
  }>
}
export type BuildReviewContextInput = {
  readonly metadata: PullRequestMetadata
  readonly reviewMode: ReviewMode
  readonly previousReviewedCommit?: string | undefined
  readonly pullRequestBaseRef: string
  readonly gitDiff: PullRequestDiff
}
export declare const buildReviewContext: ({
  metadata,
  reviewMode,
  previousReviewedCommit,
  pullRequestBaseRef,
  gitDiff,
}: BuildReviewContextInput) => ReviewContext
