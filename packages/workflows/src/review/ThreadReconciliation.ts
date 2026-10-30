import { Option, Schema } from "effect"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import { resolveRepositoryPath } from "@open-azdo/core/paths"

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

const ManagedFailureStateSchema = Schema.Struct({ kind: Schema.Literal("failure") })

type ManagedFailureState = Schema.Schema.Type<typeof ManagedFailureStateSchema>

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
  readonly summaryOnlyFindings: ReadonlyArray<ReviewFinding>
  readonly unmappedNotes: ReadonlyArray<string>
  readonly severityCounts: SeverityCounts
  readonly buildLink?: string | undefined
  readonly persistedState?: ManagedReviewState | undefined
}

export type RetainedManagedFinding = {
  readonly existingThreadId: number
  readonly finding: ReviewFinding
  readonly retentionReason: "outside-scope" | "unresolved-existing"
}

export type ManagedReviewMergeResult = {
  readonly reviewResult: NormalizedReviewResult
  readonly retainedFindings: ReadonlyArray<RetainedManagedFinding>
  readonly retainedFindingsCount: number
}

export type ThreadAction =
  | {
      readonly type: "upsert-summary"
      readonly content: string
      /** Whether the summary thread should be left resolved rather than active (passing reviews). */
      readonly resolved: boolean
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
  readonly managedThreads: ManagedThreads
  readonly summaryContent: string
  readonly summaryVerdict: NormalizedReviewResult["verdict"]
  readonly inlineFindings: ReadonlyArray<ReviewFinding>
  readonly resolvedManagedFindingIds: ReadonlyArray<number>
  readonly reviewMode: ReviewMode
  readonly scopedChangedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
  readonly scopedDeletedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
}

const isActiveThreadStatus = (status: ExistingThread["status"]) =>
  status === 1 || status === "active" || status === "pending"

const STATE_SCHEMA_VERSION = 2
const FINDING_MARKER_PREFIX = "<!-- open-azdo:"
const SUMMARY_STATE_PREFIX = "<!-- open-azdo-review:"
const FAILURE_STATE_PREFIX = "<!-- open-azdo-failure:"
const COMMENT_SUFFIX = " -->"

const decodeManagedFindingStateFromJson = Schema.decodeUnknownSync(Schema.fromJsonString(ManagedFindingStateSchema))
const decodeManagedReviewStateFromJson = Schema.decodeUnknownSync(Schema.fromJsonString(ManagedReviewStateSchema))
const decodeManagedFailureStateFromJson = Schema.decodeUnknownSync(Schema.fromJsonString(ManagedFailureStateSchema))

/** Escapes HTML delimiters so finding text cannot close or inject the appended metadata marker. */
const encodeManagedPayload = (prefix: string, state: ManagedFindingState | ManagedReviewState | ManagedFailureState) =>
  `${prefix}${JSON.stringify(state).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}${COMMENT_SUFFIX}`

const finalManagedMarkerStart = (content: string) =>
  Math.max(
    content.lastIndexOf(FINDING_MARKER_PREFIX),
    content.lastIndexOf(SUMMARY_STATE_PREFIX),
    content.lastIndexOf(FAILURE_STATE_PREFIX),
  )

/** Removes only the appended metadata marker, preserving quoted model text as untrusted prose. */
export const stripManagedStatePayload = (content: string) => {
  const start = finalManagedMarkerStart(content)
  const end = content.indexOf(COMMENT_SUFFIX, start)

  return start < 0 || end < 0 ? content : content.slice(0, start) + content.slice(end + COMMENT_SUFFIX.length)
}

const extractEmbeddedPayload = (content: string, prefix: string) => {
  const start = content.lastIndexOf(prefix)
  const end = content.indexOf(COMMENT_SUFFIX, start)

  // Only the final managed marker can be authoritative; the prose may quote another kind.
  if (start === -1 || start !== finalManagedMarkerStart(content) || end === -1) {
    return undefined
  }

  return content.slice(start + prefix.length, end)
}

/** Decodes a managed payload from already decoded thread text; invalid markers remain unmanaged. */
const decodeEmbeddedJsonComment = <A>(
  content: ExistingThread["comments"][number]["content"],
  prefix: string,
  decode: (payload: string) => A,
): A | undefined => {
  if (content === undefined || content === null) {
    return undefined
  }

  const payload = extractEmbeddedPayload(content, prefix)

  if (payload === undefined) {
    return undefined
  }

  return Option.getOrUndefined(Option.liftThrowable(decode)(payload))
}

const decodeManagedFindingState = (content: ExistingThread["comments"][number]["content"]) =>
  decodeEmbeddedJsonComment(content, FINDING_MARKER_PREFIX, decodeManagedFindingStateFromJson)

const decodeManagedReviewState = (content: ExistingThread["comments"][number]["content"]) =>
  decodeEmbeddedJsonComment(content, SUMMARY_STATE_PREFIX, decodeManagedReviewStateFromJson)

const decodeManagedFailureState = (content: ExistingThread["comments"][number]["content"]) =>
  decodeEmbeddedJsonComment(content, FAILURE_STATE_PREFIX, decodeManagedFailureStateFromJson)

/** Canonical complete finding content, independent of an optional existing-thread link. */
const findingContentKey = (finding: ReviewFinding) =>
  JSON.stringify({
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    body: finding.body,
    suggestion: finding.suggestion ?? "",
    filePath: finding.filePath,
    line: finding.line,
    endLine: getFindingEndLine(finding),
  })

export const fingerprintFinding = (finding: ReviewFinding) => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(findingContentKey(finding))

  return hasher.digest("hex")
}

/** Captures the outstanding review counts and optional run history for the managed summary marker. */
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
}): ManagedReviewState => {
  let reviewState: ManagedReviewState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    reviewedCommit,
    pullRequestBaseRef,
    verdict: reviewResult.verdict,
    severityCounts: countBySeverity(reviewResult.findings),
    findingsCount: reviewResult.findings.length,
    inlineFindingsCount: reviewResult.inlineFindings?.length ?? 0,
    unmappedNotesCount: reviewResult.unmappedNotes.length,
  }

  if (reviewHistory && reviewHistory.length > 0) {
    reviewState = { ...reviewState, reviewHistory: [...reviewHistory] }
  }

  return reviewState
}

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

/** Renders complete finding evidence without placement metadata or managed-thread markers. */
const renderFindingEvidence = (finding: ReviewFinding) => {
  const lines = [`**Severity:** ${finding.severity}`, `**Confidence:** ${finding.confidence}`, "", finding.body]

  if (finding.suggestion) {
    lines.push("", "Suggestion:", "", "```", finding.suggestion, "```")
  }

  return lines.join("\n")
}

/** Composes the final published summary, retaining evidence independently of model highlight wording. */
export const buildSummaryComment = (snapshot: SummarySnapshot) => {
  const lines = [
    `Verdict: **${snapshot.verdict}**`,
    "",
    snapshot.summary,
    "",
    `Severity counts: critical ${snapshot.severityCounts.critical}, high ${snapshot.severityCounts.high}, medium ${snapshot.severityCounts.medium}, low ${snapshot.severityCounts.low}.`,
  ]

  if (snapshot.summaryOnlyFindings.length > 0) {
    lines.push("", "Summary-only findings:")

    for (const finding of snapshot.summaryOnlyFindings) {
      lines.push(
        "",
        `**${finding.title}** — \`${finding.filePath}:${finding.line}\``,
        "",
        renderFindingEvidence(finding),
      )
    }
  }

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
    lines.push("", encodeManagedPayload(SUMMARY_STATE_PREFIX, snapshot.persistedState))
  }

  return lines.join("\n")
}

/** Operational failures never carry a review checkpoint or replace completed-review evidence. */
export const buildFailureSummaryComment = (snapshot: Pick<SummarySnapshot, "summary" | "buildLink">) => {
  const content = buildSummaryComment({
    verdict: "fail",
    summary: snapshot.summary,
    summaryOnlyFindings: [],
    unmappedNotes: [],
    severityCounts: { low: 0, medium: 0, high: 0, critical: 0 },
    buildLink: snapshot.buildLink,
  })

  return `${content}\n\n${encodeManagedPayload(FAILURE_STATE_PREFIX, { kind: "failure" })}`
}

/** Adds the managed marker only to an inline finding's complete evidence. */
export const buildInlineComment = (finding: ReviewFinding) =>
  [
    `**${finding.title}**`,
    "",
    renderFindingEvidence(finding),
    "",
    encodeManagedPayload(FINDING_MARKER_PREFIX, { kind: "finding", fingerprint: fingerprintFinding(finding), finding }),
  ].join("\n")

type ExistingSummaryThread = {
  readonly thread: ExistingThread
  readonly commentId: number
  readonly reviewState: ManagedReviewState
}

type ExistingFailureThread = {
  readonly thread: ExistingThread
  readonly commentId: number
}

type ExistingFindingThread = {
  readonly thread: ExistingThread
  readonly updatedAt: string | undefined
  readonly filePath: string | undefined
  readonly line: number | undefined
  readonly commentId: number
  readonly finding: ReviewFinding
}

type ManagedFindingThreadPartition = {
  readonly inScopeCandidates: ReadonlyArray<ExistingFindingThread>
  readonly retainedOutOfScopeFindings: ReadonlyArray<ExistingFindingThread>
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

/** Bot-owned decoded state from one complete Azure thread listing. */
export interface ManagedThreads {
  readonly summary: ExistingSummaryThread | undefined
  /** Authenticated operational failure without a completed review or skip authority. */
  readonly failure: ExistingFailureThread | undefined
  readonly findings: ReadonlyArray<ExistingFindingThread>
  /** References into the same raw listing, used to label prompt comments without re-decoding markers. */
  readonly comments: ReadonlySet<ExistingThread["comments"][number]>
}

/**
 * Establishes marker authority once at the Azure boundary. Display names and marker text never
 * establish ownership: only nondeleted comments from the token's authenticated identity qualify.
 */
export const decodeManagedThreads = (
  existingThreads: ReadonlyArray<ExistingThread>,
  authenticatedIdentity: string,
): ManagedThreads => {
  let summary: ExistingSummaryThread | undefined
  let failure: ExistingFailureThread | undefined
  const findings: ExistingFindingThread[] = []
  const comments = new Set<ExistingThread["comments"][number]>()

  for (const thread of existingThreads) {
    if (thread.isDeleted === true) {
      continue
    }

    let finding: ExistingFindingThread | undefined

    for (const comment of thread.comments) {
      if (comment.isDeleted === true || comment.author?.id !== authenticatedIdentity) {
        continue
      }

      const reviewState = decodeManagedReviewState(comment.content)
      const findingState = decodeManagedFindingState(comment.content)
      const failureState = decodeManagedFailureState(comment.content)

      if (reviewState) {
        summary ??= { thread, commentId: comment.id, reviewState }
        comments.add(comment)
      }

      if (findingState) {
        comments.add(comment)
        finding ??= {
          thread,
          commentId: comment.id,
          updatedAt: getThreadUpdatedAt(thread),
          filePath: thread.threadContext?.filePath ?? undefined,
          line: thread.threadContext?.rightFileStart?.line ?? undefined,
          finding: findingState.finding,
        }
      }

      if (failureState) {
        failure ??= { thread, commentId: comment.id }
        comments.add(comment)
      }
    }

    if (finding) findings.push(finding)
  }

  return { summary, failure, findings, comments }
}

const listActiveManagedFindingThreads = (managedThreads: ManagedThreads) =>
  managedThreads.findings.filter((existingThread) => isActiveThreadStatus(existingThread.thread.status))

/** Uses Azure's current thread coordinates, falling back to the embedded location when unavailable. */
export const resolveManagedFindingLocation = (managedFinding: ExistingFindingThread) => ({
  filePath: (managedFinding.filePath ?? managedFinding.finding.filePath).replace(/^\/+/, ""),
  line: managedFinding.line ?? managedFinding.finding.line,
  // A moved start cannot share an absolute end line from the original revision.
  endLine:
    managedFinding.thread.threadContext?.rightFileEnd?.line ??
    (managedFinding.line === undefined ? managedFinding.finding.endLine : undefined),
})

/** Keeps prompt candidates and publication decisions on the same current-location scope rule. */
export const managedFindingTouchesScopedDiff = (
  managedFinding: ExistingFindingThread,
  scopedChangedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>,
  scopedDeletedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>,
) => {
  const location = resolveManagedFindingLocation(managedFinding)

  const filePath = resolveRepositoryPath(location.filePath, {
    has: (path) => scopedChangedLinesByFile.has(path) || scopedDeletedLinesByFile.has(path),
  })

  const changedLines = scopedChangedLinesByFile.get(filePath)
  const deletedLines = scopedDeletedLinesByFile.get(filePath)

  // Iterate the finite diff sets, not a model-controlled line range that could span billions.
  const endLine = location.endLine ?? location.line

  for (const line of changedLines ?? []) {
    if (line >= location.line && line <= endLine) return true
  }

  for (const line of deletedLines ?? []) {
    if (line >= location.line && line <= endLine) return true
  }

  return false
}

/**
 * Splits active managed findings into threads the current review can explicitly reconcile and
 * threads that sit outside the scoped diff and therefore must be retained conservatively.
 */
const partitionActiveManagedFindingThreads = ({
  activeManagedFindingThreads,
  scopedChangedLinesByFile,
  scopedDeletedLinesByFile,
}: {
  readonly activeManagedFindingThreads: ReadonlyArray<ExistingFindingThread>
  readonly scopedChangedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
  readonly scopedDeletedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
}): ManagedFindingThreadPartition => {
  const inScopeCandidates: ExistingFindingThread[] = []
  const retainedOutOfScopeFindings: ExistingFindingThread[] = []

  for (const managedFinding of activeManagedFindingThreads) {
    if (managedFindingTouchesScopedDiff(managedFinding, scopedChangedLinesByFile, scopedDeletedLinesByFile)) {
      inScopeCandidates.push(managedFinding)
      continue
    }

    retainedOutOfScopeFindings.push(managedFinding)
  }

  return {
    inScopeCandidates,
    retainedOutOfScopeFindings,
  }
}

const toRetainedManagedFinding = (
  existingThread: ExistingFindingThread,
  retentionReason: RetainedManagedFinding["retentionReason"],
): RetainedManagedFinding => ({
  existingThreadId: existingThread.thread.id,
  retentionReason,
  finding: {
    ...existingThread.finding,
    managedFindingId: existingThread.thread.id,
  },
})

/** Reuses an explicit trusted identity, or exact content from a prior partial publication. */
const matchManagedFinding = (
  finding: ReviewFinding,
  existingFindings: ReadonlyArray<ExistingFindingThread>,
  claimedIds: ReadonlySet<number>,
) =>
  existingFindings.find(
    (existing) =>
      !claimedIds.has(existing.thread.id) &&
      (finding.managedFindingId === existing.thread.id ||
        (finding.managedFindingId === undefined && findingContentKey(existing.finding) === findingContentKey(finding))),
  )

/**
 * Merges the normalized review result with active managed findings that the current rerun did not
 * explicitly reconcile, preserving those older threads in the published outstanding state until
 * the model links or resolves them by thread id.
 */
export const mergeManagedReviewResult = ({
  managedThreads,
  scopedChangedLinesByFile,
  scopedDeletedLinesByFile,
  reviewResult,
}: {
  readonly managedThreads: ManagedThreads
  readonly scopedChangedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
  readonly scopedDeletedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
  readonly reviewResult: NormalizedReviewResult
}): ManagedReviewMergeResult => {
  const activeManagedFindingThreads = listActiveManagedFindingThreads(managedThreads)

  const { inScopeCandidates, retainedOutOfScopeFindings } = partitionActiveManagedFindingThreads({
    activeManagedFindingThreads,
    scopedChangedLinesByFile,
    scopedDeletedLinesByFile,
  })

  const linkedManagedFindingIds = new Set<number>()

  for (const finding of reviewResult.findings) {
    const existing = matchManagedFinding(finding, activeManagedFindingThreads, linkedManagedFindingIds)

    if (existing) linkedManagedFindingIds.add(existing.thread.id)
  }

  const resolvedManagedFindingIds = new Set(reviewResult.resolvedManagedFindingIds)

  const retainedFindings = [
    ...retainedOutOfScopeFindings.map((existingThread) => toRetainedManagedFinding(existingThread, "outside-scope")),
    ...inScopeCandidates
      .filter(
        (existingThread) =>
          !linkedManagedFindingIds.has(existingThread.thread.id) &&
          !resolvedManagedFindingIds.has(existingThread.thread.id),
      )
      // In-scope candidates stay outstanding until the model explicitly links or resolves them.
      .map((existingThread) => toRetainedManagedFinding(existingThread, "unresolved-existing")),
  ]

  if (retainedFindings.length === 0) {
    return {
      reviewResult,
      retainedFindings,
      retainedFindingsCount: 0,
    }
  }

  return {
    reviewResult: {
      ...reviewResult,
      verdict: reviewResult.verdict === "pass" ? "concerns" : reviewResult.verdict,
      findings: [...retainedFindings.map((retainedFinding) => retainedFinding.finding), ...reviewResult.findings],
      inlineFindings: [
        ...retainedFindings.map((retainedFinding) => retainedFinding.finding),
        ...reviewResult.inlineFindings,
      ],
    },
    retainedFindings,
    retainedFindingsCount: retainedFindings.length,
  }
}

export const reconcileThreads = ({
  managedThreads,
  summaryContent,
  summaryVerdict,
  inlineFindings,
  resolvedManagedFindingIds,
  reviewMode,
  scopedChangedLinesByFile,
  scopedDeletedLinesByFile,
}: ReconcileThreadsInput): ThreadAction[] => {
  const actions: ThreadAction[] = []

  // Recovery and same-commit skips resolve operational notices without rewriting completed evidence.
  if (managedThreads.failure && isActiveThreadStatus(managedThreads.failure.thread.status)) {
    actions.push({ type: "close-thread", existingThread: managedThreads.failure.thread })
  }

  if (reviewMode === "skipped") {
    return actions
  }

  const activeManagedFindingThreads = listActiveManagedFindingThreads(managedThreads)

  const { inScopeCandidates } = partitionActiveManagedFindingThreads({
    activeManagedFindingThreads,
    scopedChangedLinesByFile,
    scopedDeletedLinesByFile,
  })

  const managedFindingCandidatesById = new Map(
    inScopeCandidates.map((existingThread) => [existingThread.thread.id, existingThread] as const),
  )

  const linkedManagedFindingIds = new Set<number>()
  const processedResolvedManagedFindingIds = new Set<number>()

  for (const finding of inlineFindings) {
    const existingThread = matchManagedFinding(finding, activeManagedFindingThreads, linkedManagedFindingIds)

    if (existingThread) linkedManagedFindingIds.add(existingThread.thread.id)

    actions.push({
      type: "upsert-finding",
      content: buildInlineComment(finding),
      finding,
      existingThread: existingThread?.thread,
      commentId: existingThread?.commentId,
    })
  }

  for (const managedFindingId of resolvedManagedFindingIds) {
    if (linkedManagedFindingIds.has(managedFindingId) || processedResolvedManagedFindingIds.has(managedFindingId)) {
      continue
    }

    // Only in-scope active candidates can be resolved by this rerun.
    const existingThread = managedFindingCandidatesById.get(managedFindingId)

    if (!existingThread) {
      continue
    }

    processedResolvedManagedFindingIds.add(managedFindingId)

    actions.push({
      type: "close-thread",
      existingThread: existingThread.thread,
    })
  }

  // Persist reviewedCommit only after every finding and status mutation succeeds.
  actions.push({
    type: "upsert-summary",
    content: summaryContent,
    resolved: summaryVerdict === "pass",
    existingThread: managedThreads.summary?.thread,
    commentId: managedThreads.summary?.commentId,
  })

  return actions
}
