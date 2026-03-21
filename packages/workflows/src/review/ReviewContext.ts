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

export type ConnectedWorkItemContext = {
  readonly id: number
  readonly title: string
  readonly workItemType: string
  readonly state: string
  readonly priority?: number
  readonly assignedTo?: string
  readonly iterationPath?: string
  readonly areaPath?: string
  readonly tags: ReadonlyArray<string>
  readonly descriptionMarkdown?: string
  readonly acceptanceCriteriaMarkdown?: string
  readonly reproStepsMarkdown?: string
  readonly parent?: {
    readonly id: number
    readonly title?: string
  }
  readonly related: ReadonlyArray<{
    readonly id: number
    readonly title?: string
  }>
  readonly recentComments: ReadonlyArray<{
    readonly author: string
    readonly createdAt: string
    readonly markdown: string
  }>
}

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
    readonly items: ReadonlyArray<ConnectedWorkItemContext>
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

const buildConnectedWorkItemContext = (workItem: PullRequestWorkItem): ConnectedWorkItemContext => ({
  id: workItem.id,
  title: workItem.title,
  workItemType: workItem.workItemType,
  state: workItem.state,
  ...(workItem.priority !== undefined ? { priority: workItem.priority } : {}),
  ...(workItem.assignedTo ? { assignedTo: workItem.assignedTo } : {}),
  ...(workItem.iterationPath ? { iterationPath: workItem.iterationPath } : {}),
  ...(workItem.areaPath ? { areaPath: workItem.areaPath } : {}),
  tags: workItem.tags,
  ...(workItem.descriptionMarkdown
    ? { descriptionMarkdown: truncateText(workItem.descriptionMarkdown, MAX_WORK_ITEM_SECTION_CHARS) }
    : {}),
  ...(workItem.acceptanceCriteriaMarkdown
    ? { acceptanceCriteriaMarkdown: truncateText(workItem.acceptanceCriteriaMarkdown, MAX_WORK_ITEM_SECTION_CHARS) }
    : {}),
  ...(workItem.reproStepsMarkdown
    ? { reproStepsMarkdown: truncateText(workItem.reproStepsMarkdown, MAX_WORK_ITEM_SECTION_CHARS) }
    : {}),
  ...(workItem.parent
    ? {
        parent: {
          id: workItem.parent.id,
          ...(workItem.parent.title ? { title: workItem.parent.title } : {}),
        },
      }
    : {}),
  related: workItem.related.slice(0, MAX_RELATED_ITEMS).map((relatedItem) => ({
    id: relatedItem.id,
    ...(relatedItem.title ? { title: relatedItem.title } : {}),
  })),
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
          items: connectedWorkItems.map(buildConnectedWorkItemContext),
        },
      }
    : {}),
})
