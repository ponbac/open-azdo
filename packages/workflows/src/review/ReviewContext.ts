import {
  compressChangedLines,
  extractHunkHeaders,
  splitDiffByFile,
  type LineRange,
  type PullRequestDiff,
} from "@open-azdo/core/git"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import type { PullRequestWorkItem, PullRequestWorkItemRef } from "@open-azdo/azdo/client"
import {
  type ManagedThreads,
  stripManagedStatePayload,
  managedFindingTouchesScopedDiff,
  resolveManagedFindingLocation,
} from "./ThreadReconciliation"

const MAX_WORK_ITEM_CONTEXT_CHARS = 24_000
const MAX_RELATED_ITEMS = 4
const MAX_THREAD_CONTEXT_CHARS = 24_000
const MAX_MANAGED_FINDING_CONTEXT_CHARS = 12_000
const MAX_FILE_DIFF_DETAILS = 100
const MAX_DIFF_MANIFEST_CHARS = 250_000
const SYSTEM_THREAD_AUTHORS = new Set(["Azure Pipelines Test Service", "Microsoft.VisualStudio.Services.TFS"])
const SYSTEM_THREAD_PREFIXES = ["Policy status has been updated", "The reference refs/"]
const SYSTEM_THREAD_SNIPPETS = ["set auto-complete", "published the pull request"]
const TRUNCATION_MARKER = "... [truncated]"

const truncateText = (value: string, maxChars: number) =>
  value.length > maxChars ? `${value.slice(0, maxChars)}${TRUNCATION_MARKER}` : value

const shrinkText = (value: string) => {
  if (value.length === 0) {
    return value
  }

  const nextMaxChars = Math.max(Math.floor(value.length * 0.7), 0)
  const reducedLength = Math.min(nextMaxChars, value.length - 1)

  return truncateText(value, reducedLength)
}

const collapseBlankLines = (value: string) => value.replace(/\n{3,}/g, "\n\n")

const normalizePromptText = (value: string | null | undefined) => {
  if (!value) {
    return undefined
  }

  const normalized = collapseBlankLines(
    value
      .replace(/\u00a0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, ""),
  ).trim()

  return normalized.length > 0 ? normalized : undefined
}

export type PullRequestMetadata = {
  readonly title: string
  readonly description: string
  readonly workItemRefs?: ReadonlyArray<PullRequestWorkItemRef>
}

export type ReviewMode = "full" | "follow-up" | "skipped"

export type PromptThreadComment = {
  readonly author: string
  readonly publishedAt?: string
  readonly origin: "human" | "open-azdo"
  readonly content: string
}

export type PromptThread = {
  readonly id: number
  readonly status: ExistingThread["status"]
  readonly filePath?: string
  readonly line?: number
  readonly updatedAt?: string
  readonly managedThread: boolean
  readonly comments: ReadonlyArray<PromptThreadComment>
}

export type PromptManagedFinding = {
  readonly id: number
  readonly status: ExistingThread["status"]
  readonly resolution: "resolved" | "unresolved" | "unknown"
  readonly filePath?: string
  readonly line?: number
  readonly updatedAt?: string
  readonly title: string
  readonly severity: "low" | "medium" | "high" | "critical"
  readonly confidence: "low" | "medium" | "high"
}

export type PromptManagedFindingCandidate = {
  readonly id: number
  readonly filePath: string
  readonly line: number
  readonly endLine?: number
  readonly updatedAt?: string
  readonly title: string
  readonly body: string
  readonly suggestion?: string
  readonly severity: "low" | "medium" | "high" | "critical"
  readonly confidence: "low" | "medium" | "high"
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
    readonly renamedFrom?: string
    readonly changedLineRanges?: LineRange[]
    readonly hunkHeaders?: string[]
  }>
  readonly deletedFiles: ReadonlyArray<string>
  readonly diffMetadataTruncated?: boolean
  readonly pullRequestThreads?: {
    readonly omittedCount: number
    readonly items: ReadonlyArray<PromptThread>
  }
  readonly managedFindings?: {
    readonly omittedCount: number
    readonly items: ReadonlyArray<PromptManagedFinding>
  }
  readonly managedFindingCandidates?: {
    readonly items: ReadonlyArray<PromptManagedFindingCandidate>
  }
  readonly connectedWorkItems?: {
    readonly omittedCount: number
    readonly items: ReadonlyArray<PullRequestWorkItem>
  }
}

type BuildReviewContextInput = {
  readonly metadata: PullRequestMetadata
  readonly reviewMode: ReviewMode
  readonly previousReviewedCommit?: string | undefined
  readonly pullRequestBaseRef: string
  readonly gitDiff: PullRequestDiff
  readonly existingThreads?: ReadonlyArray<ExistingThread>
  readonly managedThreads: ManagedThreads
  readonly connectedWorkItems?: ReadonlyArray<PullRequestWorkItem> | undefined
}

type ExistingThreadComment = ExistingThread["comments"][number]

type ManagedFindingContextItem = ManagedThreads["findings"][number]

type TruncationSlot<T> = {
  readonly text: string
  readonly write: (nextText: string) => T
}

const serializeBudgetedPromptSection = <T>(items: ReadonlyArray<T>, totalCount: number) =>
  JSON.stringify({
    omittedCount: Math.max(totalCount - items.length, 0),
    items,
  })

/**
 * Shrinks the longest prompt text fields until the serialized payload fits its budget.
 * This avoids hard per-field caps while still enforcing a ceiling on prompt growth.
 */
const shrinkValueToFitSerializedBudget = <T>({
  value,
  maxSerializedChars,
  serialize,
  getSlots,
}: {
  readonly value: T
  readonly maxSerializedChars: number
  readonly serialize: (value: T) => string
  readonly getSlots: (value: T) => ReadonlyArray<TruncationSlot<T>>
}) => {
  let next = value
  let serializedLength = serialize(next).length

  while (serializedLength > maxSerializedChars) {
    // Always trim the largest remaining text field first so we preserve breadth of context.
    const slot = getSlots(next).reduce<TruncationSlot<T> | undefined>((current, candidate) => {
      if (candidate.text.length === 0) {
        return current
      }

      if (!current || candidate.text.length > current.text.length) {
        return candidate
      }

      return current
    }, undefined)

    if (!slot) {
      return undefined
    }

    const updated = slot.write(shrinkText(slot.text))
    const updatedLength = serialize(updated).length

    if (updatedLength >= serializedLength) {
      return undefined
    }

    next = updated
    serializedLength = updatedLength
  }

  return next
}

/**
 * Keeps prompt sections within a serialized character budget while preferring intact newer
 * or earlier-ranked items. Only an oversize first item is truncated to fit the budget.
 */
const selectItemsWithinSerializedBudget = <T>({
  items,
  totalCount,
  maxSerializedChars,
  truncateItemToFit,
}: {
  readonly items: ReadonlyArray<T>
  readonly totalCount: number
  readonly maxSerializedChars: number
  readonly truncateItemToFit: (item: T, maxSerializedChars: number, totalCount: number) => T | undefined
}) => {
  if (items.length === 0) {
    return undefined
  }

  const selected: T[] = []

  for (const item of items) {
    const nextSelection = [...selected, item]
    const nextSerialized = serializeBudgetedPromptSection(nextSelection, totalCount)

    if (nextSerialized.length <= maxSerializedChars) {
      selected.push(item)
      continue
    }

    // If even the highest-priority item is too large, keep a truncated version instead of
    // dropping the section entirely. Later items are omitted once the budget is exhausted.
    if (selected.length === 0) {
      const truncated = truncateItemToFit(item, maxSerializedChars, totalCount)

      if (truncated) {
        selected.push(truncated)
      }
    }

    break
  }

  return {
    omittedCount: Math.max(totalCount - selected.length, 0),
    items: selected,
  }
}

const prepareWorkItemForPrompt = (workItem: PullRequestWorkItem): PullRequestWorkItem => ({
  ...workItem,
  related: workItem.related.slice(0, MAX_RELATED_ITEMS),
})

const updateWorkItemSectionText = (
  workItem: PullRequestWorkItem,
  key: "descriptionMarkdown" | "acceptanceCriteriaMarkdown" | "reproStepsMarkdown",
  nextText: string,
): PullRequestWorkItem => {
  switch (key) {
    case "descriptionMarkdown": {
      const { descriptionMarkdown: _descriptionMarkdown, ...rest } = workItem

      return nextText.length > 0 ? { ...rest, descriptionMarkdown: nextText } : rest
    }

    case "acceptanceCriteriaMarkdown": {
      const { acceptanceCriteriaMarkdown: _acceptanceCriteriaMarkdown, ...rest } = workItem

      return nextText.length > 0 ? { ...rest, acceptanceCriteriaMarkdown: nextText } : rest
    }

    case "reproStepsMarkdown": {
      const { reproStepsMarkdown: _reproStepsMarkdown, ...rest } = workItem

      return nextText.length > 0 ? { ...rest, reproStepsMarkdown: nextText } : rest
    }
  }
}

const truncateWorkItemToFitBudget = (workItem: PullRequestWorkItem, maxSerializedChars: number, totalCount: number) =>
  shrinkValueToFitSerializedBudget({
    value: prepareWorkItemForPrompt(workItem),
    maxSerializedChars,
    serialize: (candidate) => serializeBudgetedPromptSection([candidate], totalCount),
    getSlots: (candidate) => [
      ...(candidate.descriptionMarkdown
        ? [
            {
              text: candidate.descriptionMarkdown,
              write: (nextText: string) => updateWorkItemSectionText(candidate, "descriptionMarkdown", nextText),
            },
          ]
        : []),
      ...(candidate.acceptanceCriteriaMarkdown
        ? [
            {
              text: candidate.acceptanceCriteriaMarkdown,
              write: (nextText: string) => updateWorkItemSectionText(candidate, "acceptanceCriteriaMarkdown", nextText),
            },
          ]
        : []),
      ...(candidate.reproStepsMarkdown
        ? [
            {
              text: candidate.reproStepsMarkdown,
              write: (nextText: string) => updateWorkItemSectionText(candidate, "reproStepsMarkdown", nextText),
            },
          ]
        : []),
      ...candidate.recentComments.map((comment, index) => ({
        text: comment.markdown,
        write: (nextText: string) => ({
          ...candidate,
          recentComments: candidate.recentComments.map((currentComment, commentIndex) =>
            commentIndex === index ? { ...currentComment, markdown: nextText } : currentComment,
          ),
        }),
      })),
    ],
  })

/**
 * Selects the prompt-safe work-item context shown to the reviewer model.
 * The Azure client already limits item count, so this budget mainly guards against
 * unusually large descriptions, acceptance criteria, repro steps, or comments.
 */
const selectConnectedWorkItemsForPrompt = (workItems: ReadonlyArray<PullRequestWorkItem>, totalCount: number) =>
  selectItemsWithinSerializedBudget({
    items: workItems.map(prepareWorkItemForPrompt),
    totalCount,
    maxSerializedChars: MAX_WORK_ITEM_CONTEXT_CHARS,
    truncateItemToFit: truncateWorkItemToFitBudget,
  }) satisfies NonNullable<ReviewContext["connectedWorkItems"]> | undefined

const isDeletedComment = (comment: ExistingThreadComment) => comment.isDeleted === true

const getOpeningComment = (thread: ExistingThread) =>
  thread.comments.find((comment) => !isDeletedComment(comment)) ?? thread.comments[0]

const isExplicitlyNonTextCommentType = (commentType: ExistingThreadComment["commentType"]) =>
  commentType !== undefined && commentType !== null && commentType !== "text" && commentType !== 1

const getDisplayName = (comment: ExistingThreadComment) => {
  const displayName = comment.author?.displayName?.trim()

  return displayName && displayName.length > 0 ? displayName : "Unknown"
}

const hasSystemAuthor = (comment: ExistingThreadComment) => SYSTEM_THREAD_AUTHORS.has(getDisplayName(comment))

const isSystemNoiseContent = (content: string | undefined) =>
  content
    ? SYSTEM_THREAD_PREFIXES.some((prefix) => content.startsWith(prefix)) ||
      SYSTEM_THREAD_SNIPPETS.some((snippet) => content.includes(snippet))
    : false

const isHumanConversationComment = (comment: ExistingThreadComment, managedComments: ManagedThreads["comments"]) =>
  !isDeletedComment(comment) &&
  !isExplicitlyNonTextCommentType(comment.commentType) &&
  !hasSystemAuthor(comment) &&
  !managedComments.has(comment)

const isPromptEligibleOpeningComment = (comment: ExistingThreadComment) =>
  !isExplicitlyNonTextCommentType(comment.commentType) &&
  !hasSystemAuthor(comment) &&
  !isSystemNoiseContent(normalizePromptText(comment.content ?? undefined))

/**
 * Converts a raw thread comment into the compact prompt-safe comment shape.
 * Managed comments keep only their human-readable text while human comments
 * still respect the non-text and system-author filters.
 */
const toPromptThreadComment = (
  comment: ExistingThreadComment,
  managedComments: ManagedThreads["comments"],
): PromptThreadComment | undefined => {
  const origin = managedComments.has(comment) ? "open-azdo" : "human"
  const rawContent = origin === "open-azdo" ? stripManagedStatePayload(comment.content ?? "") : comment.content
  const content = normalizePromptText(rawContent ?? undefined)

  if (!content) {
    return undefined
  }

  if (origin === "human" && isExplicitlyNonTextCommentType(comment.commentType)) {
    return undefined
  }

  if (origin === "human" && hasSystemAuthor(comment)) {
    return undefined
  }

  let promptComment: PromptThreadComment = {
    author: getDisplayName(comment),
    origin,
    content,
  }

  if (comment.publishedDate) {
    promptComment = { ...promptComment, publishedAt: comment.publishedDate }
  }

  return promptComment
}

const getThreadUpdatedAt = (thread: ExistingThread) =>
  thread.comments.reduce<string | undefined>((latest, comment) => {
    const publishedAt = comment.publishedDate ?? undefined

    if (!publishedAt) {
      return latest
    }

    if (!latest) {
      return publishedAt
    }

    return publishedAt > latest ? publishedAt : latest
  }, undefined)

const compareUpdatedAtThenIdDesc = (
  left: { readonly id: number; readonly updatedAt?: string },
  right: { readonly id: number; readonly updatedAt?: string },
) => {
  const leftUpdatedAt = left.updatedAt ?? ""
  const rightUpdatedAt = right.updatedAt ?? ""

  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt.localeCompare(leftUpdatedAt)
  }

  return right.id - left.id
}

const resolveManagedFindingResolution = (status: ExistingThread["status"]): PromptManagedFinding["resolution"] => {
  // Azure DevOps thread statuses can arrive as either enums or human-readable strings.
  if (status === 1 || status === "active" || status === "pending") {
    return "unresolved"
  }

  if (status === 2 || status === 4 || status === "fixed" || status === "closed") {
    return "resolved"
  }

  return "unknown"
}

/** Projects an existing managed finding into its compact historical prompt record. */
const toPromptManagedFinding = ({
  thread,
  updatedAt,
  filePath,
  line,
  finding,
}: ManagedFindingContextItem): PromptManagedFinding => {
  let promptFinding: PromptManagedFinding = {
    id: thread.id,
    status: thread.status,
    resolution: resolveManagedFindingResolution(thread.status),
    filePath: filePath ?? finding.filePath,
    line: line ?? finding.line,
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
  }

  if (updatedAt !== undefined) {
    promptFinding = { ...promptFinding, updatedAt }
  }

  return promptFinding
}

/** Preserves current coordinates and evidence for findings the review can explicitly reconcile. */
const toPromptManagedFindingCandidate = (managedFinding: ManagedFindingContextItem): PromptManagedFindingCandidate => {
  const location = resolveManagedFindingLocation(managedFinding)

  let candidate: PromptManagedFindingCandidate = {
    id: managedFinding.thread.id,
    filePath: location.filePath,
    line: location.line,
    title: managedFinding.finding.title,
    body: managedFinding.finding.body,
    severity: managedFinding.finding.severity,
    confidence: managedFinding.finding.confidence,
  }

  if (location.endLine !== undefined) {
    candidate = { ...candidate, endLine: location.endLine }
  }

  if (managedFinding.updatedAt !== undefined) {
    candidate = { ...candidate, updatedAt: managedFinding.updatedAt }
  }

  if (managedFinding.finding.suggestion !== undefined) {
    candidate = { ...candidate, suggestion: managedFinding.finding.suggestion }
  }

  return candidate
}

const truncatePromptThreadToFitBudget = (thread: PromptThread, maxSerializedChars: number, totalCount: number) =>
  shrinkValueToFitSerializedBudget({
    value: thread,
    maxSerializedChars,
    serialize: (candidate) => serializeBudgetedPromptSection([candidate], totalCount),
    getSlots: (candidate) =>
      candidate.comments.map((comment, index) => ({
        text: comment.content,
        write: (nextText: string) => ({
          ...candidate,
          comments: candidate.comments.map((currentComment, commentIndex) =>
            commentIndex === index ? { ...currentComment, content: nextText } : currentComment,
          ),
        }),
      })),
  })

/**
 * Keeps the managed-finding summary context small by retaining the newest items first and then
 * dropping older entries once the serialized section reaches its budget.
 */
const selectManagedFindingsForPrompt = (managedThreads: ManagedThreads) => {
  const managedFindings = managedThreads.findings.map(toPromptManagedFinding).sort(compareUpdatedAtThenIdDesc)

  if (managedFindings.length === 0) {
    return undefined
  }

  const selected: PromptManagedFinding[] = []

  for (const managedFinding of managedFindings) {
    const nextSelection = [...selected, managedFinding]

    if (
      serializeBudgetedPromptSection(nextSelection, managedFindings.length).length > MAX_MANAGED_FINDING_CONTEXT_CHARS
    ) {
      break
    }

    selected.push(managedFinding)
  }

  if (selected.length === 0) {
    return undefined
  }

  return {
    omittedCount: Math.max(managedFindings.length - selected.length, 0),
    items: selected,
  } satisfies NonNullable<ReviewContext["managedFindings"]>
}

/**
 * Provides the reviewer model with only active managed findings that still overlap the current
 * review scope. Keep this authority pool complete: omitting eligible IDs would prevent the model
 * from resolving them even when it verifies that their concerns are fixed.
 */
const selectManagedFindingCandidatesForPrompt = (managedThreads: ManagedThreads, gitDiff: PullRequestDiff) => {
  const managedFindingCandidates = managedThreads.findings
    .flatMap((managedFinding) => {
      if (
        resolveManagedFindingResolution(managedFinding.thread.status) !== "unresolved" ||
        !managedFindingTouchesScopedDiff(managedFinding, gitDiff.changedLinesByFile, gitDiff.deletedLinesByFile)
      ) {
        return []
      }

      return [toPromptManagedFindingCandidate(managedFinding)]
    })
    .sort(compareUpdatedAtThenIdDesc)

  return managedFindingCandidates.length > 0 ? { items: managedFindingCandidates } : undefined
}

/** Keeps every Git path visible while treating hunk/range summaries as optional navigation aids. */
const buildDiffManifest = (gitDiff: PullRequestDiff): Pick<ReviewContext, "changedFiles" | "diffMetadataTruncated"> => {
  const patches = new Map(splitDiffByFile(gitDiff.diffText).map((file) => [file.path, file.patch]))
  let diffMetadataTruncated = false

  const fileIdentities = gitDiff.changedFiles.map((path) => {
    const renamedFrom = gitDiff.renamedFromByFile.get(path)

    return renamedFrom === undefined ? { path } : { path, renamedFrom }
  })

  const changedFiles = fileIdentities.map((file) => {
    const path = file.path
    const lineRanges = compressChangedLines(gitDiff.changedLinesByFile.get(path) ?? new Set<number>())
    const hunkHeaders = extractHunkHeaders(patches.get(path) ?? "")

    if (lineRanges.length > MAX_FILE_DIFF_DETAILS || hunkHeaders.length > MAX_FILE_DIFF_DETAILS) {
      diffMetadataTruncated = true
    }

    return {
      ...file,
      changedLineRanges: lineRanges.slice(0, MAX_FILE_DIFF_DETAILS),
      hunkHeaders: hunkHeaders.slice(0, MAX_FILE_DIFF_DETAILS),
    }
  })

  if (JSON.stringify({ changedFiles, deletedFiles: gitDiff.deletedFiles }).length > MAX_DIFF_MANIFEST_CHARS) {
    // A wide diff can exceed the detail budget even with one hunk per file. Paths are never capped;
    // they may exceed this target on their own, and Git remains the complete source of patch detail.
    return {
      changedFiles: fileIdentities,
      diffMetadataTruncated: true,
    }
  }

  return { changedFiles, diffMetadataTruncated }
}

/**
 * Selects the prompt-safe thread context shown to the reviewer model.
 * The filter keeps user discussion, allows mixed managed threads with human replies,
 * and drops older threads once the serialized thread section reaches its budget.
 */
const selectPullRequestThreadsForPrompt = (
  threads: ReadonlyArray<ExistingThread>,
  managedComments: ManagedThreads["comments"],
) => {
  const eligibleThreads = threads
    .flatMap((thread) => {
      const promptThread = toPromptThread(thread, managedComments)

      return promptThread ? [promptThread] : []
    })
    .sort(compareUpdatedAtThenIdDesc)

  return selectItemsWithinSerializedBudget({
    items: eligibleThreads,
    totalCount: eligibleThreads.length,
    maxSerializedChars: MAX_THREAD_CONTEXT_CHARS,
    truncateItemToFit: truncatePromptThreadToFitBudget,
  }) satisfies NonNullable<ReviewContext["pullRequestThreads"]> | undefined
}

/**
 * Converts an Azure DevOps thread into the compact prompt shape.
 * Hidden managed-state payloads are stripped so the model only sees human-readable text.
 */
const toPromptThread = (
  thread: ExistingThread,
  managedComments: ManagedThreads["comments"],
): PromptThread | undefined => {
  if (thread.isDeleted === true) {
    return undefined
  }

  const openingComment = getOpeningComment(thread)

  if (!openingComment || !isPromptEligibleOpeningComment(openingComment)) {
    return undefined
  }

  const comments = thread.comments.flatMap((comment) => {
    if (isDeletedComment(comment)) {
      return []
    }

    const promptComment = toPromptThreadComment(comment, managedComments)

    return promptComment ? [promptComment] : []
  })

  if (comments.length === 0) {
    return undefined
  }

  const managedThread = comments.some((comment) => comment.origin === "open-azdo")

  if (managedThread && !thread.comments.some((comment) => isHumanConversationComment(comment, managedComments))) {
    return undefined
  }

  const updatedAt = getThreadUpdatedAt(thread)
  const filePath = thread.threadContext?.filePath
  const line = thread.threadContext?.rightFileStart?.line ?? undefined

  let promptThread: PromptThread = {
    id: thread.id,
    status: thread.status,
    managedThread,
    comments,
  }

  if (filePath !== undefined) {
    promptThread = { ...promptThread, filePath }
  }

  if (line !== undefined) {
    promptThread = { ...promptThread, line }
  }

  if (updatedAt !== undefined) {
    promptThread = { ...promptThread, updatedAt }
  }

  return promptThread
}

/**
 * Shapes decoded Azure and git inputs into budgeted reviewer context. Optional sections are
 * omitted when absent, and persisted bot payloads are stripped from human discussion text.
 */
export const buildReviewContext = ({
  metadata,
  reviewMode,
  previousReviewedCommit,
  pullRequestBaseRef,
  gitDiff,
  existingThreads,
  managedThreads,
  connectedWorkItems,
}: BuildReviewContextInput): ReviewContext => {
  const pullRequestThreads = existingThreads
    ? selectPullRequestThreadsForPrompt(existingThreads, managedThreads.comments)
    : undefined

  const managedFindings = selectManagedFindingsForPrompt(managedThreads)

  const managedFindingCandidates = selectManagedFindingCandidatesForPrompt(managedThreads, gitDiff)

  const totalConnectedWorkItemCount = metadata.workItemRefs?.length ?? connectedWorkItems?.length ?? 0

  const promptWorkItems =
    connectedWorkItems && connectedWorkItems.length > 0
      ? selectConnectedWorkItemsForPrompt(connectedWorkItems, totalConnectedWorkItemCount)
      : undefined

  let context: ReviewContext = {
    pullRequest: {
      title: metadata.title,
      description: metadata.description,
    },
    reviewMode,
    pullRequestBaseRef,
    baseRef: gitDiff.baseRef,
    headRef: gitDiff.headRef,
    ...buildDiffManifest(gitDiff),
    deletedFiles: gitDiff.deletedFiles,
  }

  if (previousReviewedCommit !== undefined) {
    context = { ...context, previousReviewedCommit }
  }

  if (pullRequestThreads !== undefined) {
    context = { ...context, pullRequestThreads }
  }

  if (managedFindings !== undefined) {
    context = { ...context, managedFindings }
  }

  if (managedFindingCandidates !== undefined) {
    context = { ...context, managedFindingCandidates }
  }

  if (promptWorkItems !== undefined) {
    context = { ...context, connectedWorkItems: promptWorkItems }
  }

  return context
}
