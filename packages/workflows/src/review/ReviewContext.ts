import {
  compressChangedLines,
  extractHunkHeaders,
  splitDiffByFile,
  type LineRange,
  type PullRequestDiff,
} from "@open-azdo/core/git"
import type { PullRequestWorkItem, PullRequestWorkItemRef } from "@open-azdo/azdo/client"

const MAX_WORK_ITEM_SECTION_CHARS = 800
const MAX_WORK_ITEM_COMMENT_CHARS = 400
const MAX_RELATED_ITEMS = 4

const truncateText = (value: string, maxChars: number) =>
  value.length > maxChars ? `${value.slice(0, maxChars)}... [truncated]` : value

export type PullRequestMetadata = {
  readonly title: string
  readonly description: string
  readonly workItemRefs?: ReadonlyArray<PullRequestWorkItemRef>
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
  readonly connectedWorkItems?: {
    readonly omittedCount: number
    readonly items: ReadonlyArray<PullRequestWorkItem>
  }
}

export type BuildReviewContextInput = {
  readonly metadata: PullRequestMetadata
  readonly reviewMode: ReviewMode
  readonly previousReviewedCommit?: string | undefined
  readonly pullRequestBaseRef: string
  readonly gitDiff: PullRequestDiff
  readonly connectedWorkItems?: ReadonlyArray<PullRequestWorkItem>
}

const truncateWorkItemForPrompt = (workItem: PullRequestWorkItem): PullRequestWorkItem => ({
  ...workItem,
  ...(workItem.descriptionMarkdown
    ? { descriptionMarkdown: truncateText(workItem.descriptionMarkdown, MAX_WORK_ITEM_SECTION_CHARS) }
    : {}),
  ...(workItem.acceptanceCriteriaMarkdown
    ? { acceptanceCriteriaMarkdown: truncateText(workItem.acceptanceCriteriaMarkdown, MAX_WORK_ITEM_SECTION_CHARS) }
    : {}),
  ...(workItem.reproStepsMarkdown
    ? { reproStepsMarkdown: truncateText(workItem.reproStepsMarkdown, MAX_WORK_ITEM_SECTION_CHARS) }
    : {}),
  related: workItem.related.slice(0, MAX_RELATED_ITEMS),
  recentComments: workItem.recentComments.map((comment) => ({
    author: comment.author,
    createdAt: comment.createdAt,
    markdown: truncateText(comment.markdown, MAX_WORK_ITEM_COMMENT_CHARS),
  })),
})

export const buildReviewContext = ({
  metadata,
  reviewMode,
  previousReviewedCommit,
  pullRequestBaseRef,
  gitDiff,
  connectedWorkItems,
}: BuildReviewContextInput): ReviewContext => ({
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
    changedLineRanges: compressChangedLines(gitDiff.changedLinesByFile.get(file.path) ?? new Set<number>()),
    hunkHeaders: extractHunkHeaders(file.patch),
  })),
  ...(connectedWorkItems && connectedWorkItems.length > 0
    ? {
        connectedWorkItems: {
          omittedCount: Math.max((metadata.workItemRefs?.length ?? 0) - connectedWorkItems.length, 0),
          items: connectedWorkItems.map(truncateWorkItemForPrompt),
        },
      }
    : {}),
})
