import { Option, Schema } from "effect"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import { normalizePath } from "@open-azdo/core/paths"

import {
  countBySeverity,
  getFindingEndLine,
  type NormalizedReviewResult,
  ReviewFindingSchema,
  type ReviewFinding,
} from "./ReviewOutput"
import type { ReviewMode } from "./ReviewContext"

const ManagedFindingStateSchema = Schema.Struct({
  kind: Schema.Literal("finding"),
  fingerprint: Schema.String,
  finding: ReviewFindingSchema,
})
type ManagedFindingState = Schema.Schema.Type<typeof ManagedFindingStateSchema>

const SeverityCountsSchema = Schema.Struct({
  low: Schema.Int,
  medium: Schema.Int,
  high: Schema.Int,
  critical: Schema.Int,
})
export type SeverityCounts = Schema.Schema.Type<typeof SeverityCountsSchema>

const ReviewHistoryTokensSchema = Schema.Struct({
  input: Schema.Int,
  output: Schema.Int,
  reasoning: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
})
export type ReviewHistoryTokens = Schema.Schema.Type<typeof ReviewHistoryTokensSchema>

const ReviewHistoryEntrySchema = Schema.Struct({
  reviewedCommit: Schema.String,
  reviewedAt: Schema.optionalKey(Schema.String),
  reviewMode: Schema.Literals(["full", "follow-up"]),
  model: Schema.String,
  variant: Schema.optionalKey(Schema.String),
  buildNumber: Schema.optionalKey(Schema.String),
  buildId: Schema.optionalKey(Schema.String),
  buildLink: Schema.optionalKey(Schema.String),
  costUsd: Schema.optionalKey(Schema.Number),
  tokens: Schema.optionalKey(ReviewHistoryTokensSchema),
})
export type ReviewHistoryEntry = Schema.Schema.Type<typeof ReviewHistoryEntrySchema>

export const ManagedReviewStateSchema = Schema.Struct({
  schemaVersion: Schema.Int,
  reviewedCommit: Schema.String,
  pullRequestBaseRef: Schema.String,
  verdict: Schema.Literals(["pass", "concerns", "fail"]),
  severityCounts: SeverityCountsSchema,
  findingsCount: Schema.Int,
  inlineFindingsCount: Schema.Int,
  unmappedNotesCount: Schema.Int,
  reviewHistory: Schema.optionalKey(Schema.Array(ReviewHistoryEntrySchema)),
})
export type ManagedReviewState = Schema.Schema.Type<typeof ManagedReviewStateSchema>

export const SKIPPED_REVIEW_SUMMARY = "⏭️ No new commits since the last managed review. Previous verdict still applies."

type SummarySnapshot = {
  readonly verdict: NormalizedReviewResult["verdict"]
  readonly summary: string
  readonly unmappedNotes: ReadonlyArray<string>
  readonly severityCounts: SeverityCounts
  readonly buildLink?: string | undefined
  readonly persistedState?: ManagedReviewState | undefined
}

export type FollowUpReviewMergeResult = {
  readonly reviewResult: NormalizedReviewResult
  readonly carriedForwardFindings: ReadonlyArray<ReviewFinding>
  readonly carriedForwardFindingsCount: number
}

export type ThreadAction =
  | {
      readonly type: "upsert-summary"
      readonly content: string
      readonly existingThread: ExistingThread | undefined
      readonly commentId: number | undefined
    }
  | {
      readonly type: "upsert-finding"
      readonly content: string
      readonly finding: ReviewFinding
      readonly existingThread: ExistingThread | undefined
      readonly commentId: number | undefined
    }
  | {
      readonly type: "close-thread"
      readonly existingThread: ExistingThread
    }

type ReconcileThreadsInput = {
  readonly existingThreads: ReadonlyArray<ExistingThread>
  readonly summaryContent: string
  readonly inlineFindings: ReadonlyArray<ReviewFinding>
  readonly reviewMode: ReviewMode
  readonly scopedChangedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
  readonly scopedDeletedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
}

const isActiveThreadStatus = (status: ExistingThread["status"]) =>
  status === 1 || status === "active" || status === "pending"

const STATE_SCHEMA_VERSION = 2
const FINDING_MARKER_PREFIX = "<!-- open-azdo:"
const SUMMARY_STATE_PREFIX = "<!-- open-azdo-review:"
const COMMENT_SUFFIX = " -->"

const decodeManagedFindingStateFromJson = Schema.decodeUnknownSync(Schema.fromJsonString(ManagedFindingStateSchema))
const decodeManagedReviewStateFromJson = Schema.decodeUnknownSync(Schema.fromJsonString(ManagedReviewStateSchema))

const encodeManagedFindingState = (findingState: ManagedFindingState) =>
  `${FINDING_MARKER_PREFIX}${JSON.stringify(findingState)}${COMMENT_SUFFIX}`

const encodeManagedReviewState = (reviewState: ManagedReviewState) =>
  `${SUMMARY_STATE_PREFIX}${JSON.stringify(reviewState)}${COMMENT_SUFFIX}`

const extractEmbeddedPayload = (content: string, prefix: string) => {
  const start = content.indexOf(prefix)
  const end = content.indexOf(COMMENT_SUFFIX, start)
  if (start === -1 || end === -1) {
    return undefined
  }
  return content.slice(start + prefix.length, end)
}

const decodeEmbeddedJsonComment = <A>(
  content: unknown,
  prefix: string,
  decode: (payload: string) => A,
): A | undefined => {
  if (typeof content !== "string") {
    return undefined
  }

  const payload = extractEmbeddedPayload(content, prefix)
  if (payload === undefined) {
    return undefined
  }

  return Option.getOrUndefined(Option.liftThrowable(decode)(payload))
}

const decodeManagedFindingState = (content: unknown) =>
  decodeEmbeddedJsonComment(content, FINDING_MARKER_PREFIX, decodeManagedFindingStateFromJson)

const decodeManagedReviewState = (content: unknown) =>
  decodeEmbeddedJsonComment(content, SUMMARY_STATE_PREFIX, decodeManagedReviewStateFromJson)

export const fingerprintFinding = (finding: ReviewFinding) => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(
    JSON.stringify({
      severity: finding.severity,
      confidence: finding.confidence,
      title: finding.title,
      body: finding.body,
      suggestion: finding.suggestion ?? "",
      filePath: normalizePath(finding.filePath),
      line: finding.line,
      endLine: getFindingEndLine(finding),
    }),
  )
  return hasher.digest("hex")
}

export const buildManagedReviewState = ({
  reviewedCommit,
  pullRequestBaseRef,
  reviewResult,
  reviewHistory,
}: {
  readonly reviewedCommit: string
  readonly pullRequestBaseRef: string
  readonly reviewResult: NormalizedReviewResult & {
    readonly inlineFindings?: ReadonlyArray<ReviewFinding>
  }
  readonly reviewHistory?: ReadonlyArray<ReviewHistoryEntry> | undefined
}): ManagedReviewState => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  reviewedCommit,
  pullRequestBaseRef,
  verdict: reviewResult.verdict,
  severityCounts: countBySeverity(reviewResult.findings),
  findingsCount: reviewResult.findings.length,
  inlineFindingsCount: reviewResult.inlineFindings?.length ?? 0,
  unmappedNotesCount: reviewResult.unmappedNotes.length,
  ...(reviewHistory && reviewHistory.length > 0 ? { reviewHistory: [...reviewHistory] } : {}),
})

const shortCommit = (value: string) => value.slice(0, 12)

const formatInteger = (value: number) => new Intl.NumberFormat("en-US").format(value)

const formatCostUsd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value)

const escapeTableCell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", "<br>")

const formatReviewLabel = (entry: ReviewHistoryEntry) => {
  const buildLabel = entry.buildNumber
    ? `Build ${entry.buildNumber}`
    : entry.buildId
      ? `Build ${entry.buildId}`
      : undefined
  const commitLabel = shortCommit(entry.reviewedCommit)

  if (buildLabel && entry.buildLink) {
    return `[${buildLabel}](${entry.buildLink}) · ${commitLabel}`
  }

  if (buildLabel) {
    return `${buildLabel} · ${commitLabel}`
  }

  return commitLabel
}

const formatReviewTimestamp = (entry: ReviewHistoryEntry) => {
  if (!entry.reviewedAt) {
    return "-"
  }

  const date = new Date(entry.reviewedAt)
  if (Number.isNaN(date.valueOf())) {
    return entry.reviewedAt
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
    timeZone: "UTC",
  }).format(date)
}

const formatTokenBreakdown = (tokens: ReviewHistoryTokens | undefined) => {
  if (!tokens) {
    return "-"
  }

  const segments = [`input ${formatInteger(tokens.input)}`, `output ${formatInteger(tokens.output)}`]

  if (tokens.reasoning > 0) {
    segments.push(`reasoning ${formatInteger(tokens.reasoning)}`)
  }

  if (tokens.cacheRead > 0) {
    segments.push(`cache read ${formatInteger(tokens.cacheRead)}`)
  }

  if (tokens.cacheWrite > 0) {
    segments.push(`cache write ${formatInteger(tokens.cacheWrite)}`)
  }

  return segments.join(", ")
}

const formatModelLabel = (entry: ReviewHistoryEntry) =>
  entry.variant ? `${entry.model} (${entry.variant})` : entry.model

const appendReviewHistorySection = (lines: string[], reviewHistory: ReadonlyArray<ReviewHistoryEntry>) => {
  if (reviewHistory.length === 0) {
    return
  }

  lines.push(
    "",
    "| Review | Reviewed At (UTC) | Mode | Model | Tokens | Cost |",
    "| --- | --- | --- | --- | --- | --- |",
  )

  for (const entry of [...reviewHistory].reverse()) {
    lines.push(
      `| ${escapeTableCell(formatReviewLabel(entry))} | ${escapeTableCell(formatReviewTimestamp(entry))} | ${escapeTableCell(entry.reviewMode)} | ${escapeTableCell(formatModelLabel(entry))} | ${escapeTableCell(formatTokenBreakdown(entry.tokens))} | ${escapeTableCell(entry.costUsd !== undefined ? formatCostUsd(entry.costUsd) : "-")} |`,
    )
  }
}

export const buildSummaryComment = (snapshot: SummarySnapshot) => {
  const lines = [
    `Verdict: **${snapshot.verdict}**`,
    "",
    snapshot.summary,
    "",
    `Severity counts: critical ${snapshot.severityCounts.critical}, high ${snapshot.severityCounts.high}, medium ${snapshot.severityCounts.medium}, low ${snapshot.severityCounts.low}.`,
  ]

  if (snapshot.unmappedNotes.length > 0) {
    lines.push("", "Summary-only notes:")
    for (const note of snapshot.unmappedNotes) {
      lines.push(`- ${note}`)
    }
  }

  if (snapshot.buildLink) {
    lines.push("", `Build: ${snapshot.buildLink}`)
  }

  appendReviewHistorySection(lines, snapshot.persistedState?.reviewHistory ?? [])

  if (snapshot.persistedState) {
    lines.push("", encodeManagedReviewState(snapshot.persistedState))
  }

  return lines.join("\n")
}

export const buildInlineComment = (finding: ReviewFinding) =>
  [
    `**${finding.title}**`,
    "",
    `**Severity:** ${finding.severity}`,
    `**Confidence:** ${finding.confidence}`,
    "",
    finding.body,
    finding.suggestion ? `\nSuggestion:\n\n\`\`\`\n${finding.suggestion}\n\`\`\`` : "",
    "",
    encodeManagedFindingState({ kind: "finding", fingerprint: fingerprintFinding(finding), finding }),
  ]
    .filter(Boolean)
    .join("\n")

type ExistingSummaryThread = {
  readonly thread: ExistingThread
  readonly commentId: number
  readonly reviewState: ManagedReviewState
}

type ExistingFindingThread = {
  readonly thread: ExistingThread
  readonly updatedAt: string | undefined
  readonly filePath: string | undefined
  readonly line: number | undefined
  readonly commentId: number
  readonly fingerprint: string
  readonly finding: ReviewFinding
}

export const findManagedSummaryThread = (
  existingThreads: ReadonlyArray<ExistingThread>,
): ExistingSummaryThread | undefined => {
  for (const thread of existingThreads) {
    for (const comment of thread.comments) {
      const reviewState = decodeManagedReviewState(comment.content)
      if (reviewState) {
        return {
          thread,
          commentId: comment.id,
          reviewState,
        }
      }
    }
  }

  return undefined
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

/**
 * Lists every managed finding thread by decoding the embedded finding payload once and attaching
 * the thread metadata that later prompt shaping and reconciliation logic need.
 */
export const listManagedFindingThreads = (
  existingThreads: ReadonlyArray<ExistingThread>,
): ReadonlyArray<ExistingFindingThread> => {
  const managed: ExistingFindingThread[] = []

  for (const thread of existingThreads) {
    for (const comment of thread.comments) {
      const findingState = decodeManagedFindingState(comment.content)
      if (!findingState) {
        continue
      }

      const updatedAt = getThreadUpdatedAt(thread)

      managed.push({
        thread,
        updatedAt,
        filePath: thread.threadContext?.filePath ?? undefined,
        line: thread.threadContext?.rightFileStart?.line ?? undefined,
        commentId: comment.id,
        fingerprint: findingState.fingerprint,
        finding: findingState.finding,
      })
      break
    }
  }

  return managed
}

const findingTouchesScopedDiff = (
  finding: ReviewFinding,
  scopedChangedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>,
  scopedDeletedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>,
) => {
  const filePath = normalizePath(finding.filePath)
  const changedLines = scopedChangedLinesByFile.get(filePath)
  const deletedLines = scopedDeletedLinesByFile.get(filePath)

  for (let line = finding.line; line <= getFindingEndLine(finding); line += 1) {
    if (changedLines?.has(line) || deletedLines?.has(line)) {
      return true
    }
  }

  return false
}

/**
 * Merges the current follow-up result with still-open managed findings that sit outside the newly
 * scoped diff, while returning the carry-forward list separately so later summary rendering can
 * describe that state without mutating model-authored text.
 */
export const mergeFollowUpReviewResult = ({
  existingThreads,
  scopedChangedLinesByFile,
  scopedDeletedLinesByFile,
  reviewResult,
}: {
  readonly existingThreads: ReadonlyArray<ExistingThread>
  readonly scopedChangedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
  readonly scopedDeletedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
  readonly reviewResult: NormalizedReviewResult
}): FollowUpReviewMergeResult => {
  const carriedForwardFindings = listManagedFindingThreads(existingThreads)
    .filter((existingThread) => isActiveThreadStatus(existingThread.thread.status))
    .filter(
      (existingThread) =>
        !findingTouchesScopedDiff(existingThread.finding, scopedChangedLinesByFile, scopedDeletedLinesByFile),
    )
    .map((existingThread) => existingThread.finding)

  if (carriedForwardFindings.length === 0) {
    return {
      reviewResult,
      carriedForwardFindings,
      carriedForwardFindingsCount: 0,
    }
  }

  return {
    reviewResult: {
      ...reviewResult,
      verdict: reviewResult.verdict === "pass" ? "concerns" : reviewResult.verdict,
      findings: [...carriedForwardFindings, ...reviewResult.findings],
      inlineFindings: [...carriedForwardFindings, ...reviewResult.inlineFindings],
    },
    carriedForwardFindings,
    carriedForwardFindingsCount: carriedForwardFindings.length,
  }
}

export const reconcileThreads = ({
  existingThreads,
  summaryContent,
  inlineFindings,
  reviewMode,
  scopedChangedLinesByFile,
  scopedDeletedLinesByFile,
}: ReconcileThreadsInput): ThreadAction[] => {
  const actions: ThreadAction[] = []
  const existingSummary = findManagedSummaryThread(existingThreads)

  actions.push({
    type: "upsert-summary",
    content: summaryContent,
    existingThread: existingSummary?.thread,
    commentId: existingSummary?.commentId,
  })

  if (reviewMode === "skipped") {
    return actions
  }

  const existingFindingsByFingerprint = new Map(
    listManagedFindingThreads(existingThreads).map(
      (existingThread) => [existingThread.fingerprint, existingThread] as const,
    ),
  )
  const activeFingerprints = new Set<string>()

  for (const finding of inlineFindings) {
    const fingerprint = fingerprintFinding(finding)
    activeFingerprints.add(fingerprint)

    const existingThread = existingFindingsByFingerprint.get(fingerprint)
    actions.push({
      type: "upsert-finding",
      content: buildInlineComment(finding),
      finding,
      existingThread: existingThread?.thread,
      commentId: existingThread?.commentId,
    })
  }

  for (const existingThread of existingFindingsByFingerprint.values()) {
    if (activeFingerprints.has(existingThread.fingerprint)) {
      continue
    }

    if (
      reviewMode === "follow-up" &&
      !findingTouchesScopedDiff(existingThread.finding, scopedChangedLinesByFile, scopedDeletedLinesByFile)
    ) {
      continue
    }

    actions.push({
      type: "close-thread",
      existingThread: existingThread.thread,
    })
  }

  return actions
}
