import { Option, Schema } from "effect"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import { normalizePath } from "@open-azdo/core/paths"

import {
  countBySeverity,
  getFindingEndLine,
  type NormalizedReviewResult,
  ReviewFindingSchema,
  type ReviewFinding,
  type ReviewResult,
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

export const ManagedReviewStateSchema = Schema.Struct({
  schemaVersion: Schema.Int,
  reviewedCommit: Schema.String,
  pullRequestBaseRef: Schema.String,
  verdict: Schema.Literals(["pass", "concerns", "fail"]),
  severityCounts: SeverityCountsSchema,
  findingsCount: Schema.Int,
  inlineFindingsCount: Schema.Int,
  unmappedNotesCount: Schema.Int,
})
export type ManagedReviewState = Schema.Schema.Type<typeof ManagedReviewStateSchema>

export const SKIPPED_REVIEW_SUMMARY = "⏭️ No new commits since the last managed review. Previous verdict still applies."

type SummarySnapshot = {
  readonly verdict: ReviewResult["verdict"]
  readonly summary: string
  readonly unmappedNotes: ReadonlyArray<string>
  readonly severityCounts: SeverityCounts
  readonly buildLink?: string | undefined
  readonly persistedState?: ManagedReviewState | undefined
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

const STATE_SCHEMA_VERSION = 1
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
}: {
  readonly reviewedCommit: string
  readonly pullRequestBaseRef: string
  readonly reviewResult: ReviewResult & {
    readonly inlineFindings?: ReadonlyArray<ReviewFinding>
  }
}): ManagedReviewState => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  reviewedCommit,
  pullRequestBaseRef,
  verdict: reviewResult.verdict,
  severityCounts: countBySeverity(reviewResult.findings),
  findingsCount: reviewResult.findings.length,
  inlineFindingsCount: reviewResult.inlineFindings?.length ?? 0,
  unmappedNotesCount: reviewResult.unmappedNotes.length,
})

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

const listManagedFindingThreads = (
  existingThreads: ReadonlyArray<ExistingThread>,
): ReadonlyArray<ExistingFindingThread> => {
  const managed: ExistingFindingThread[] = []

  for (const thread of existingThreads) {
    for (const comment of thread.comments) {
      const findingState = decodeManagedFindingState(comment.content)
      if (!findingState) {
        continue
      }

      managed.push({
        thread,
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

const appendFollowUpSummary = (summary: string, carriedForwardFindingsCount: number) =>
  [
    summary,
    "",
    `Still tracking ${carriedForwardFindingsCount} managed finding${carriedForwardFindingsCount === 1 ? "" : "s"} from earlier reviews outside this follow-up diff.`,
  ].join("\n")

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
}): NormalizedReviewResult => {
  const carriedForwardFindings = listManagedFindingThreads(existingThreads)
    .filter((existingThread) => existingThread.thread.status === 1)
    .filter(
      (existingThread) =>
        !findingTouchesScopedDiff(existingThread.finding, scopedChangedLinesByFile, scopedDeletedLinesByFile),
    )
    .map((existingThread) => existingThread.finding)

  if (carriedForwardFindings.length === 0) {
    return reviewResult
  }

  return {
    ...reviewResult,
    verdict: reviewResult.verdict === "pass" ? "concerns" : reviewResult.verdict,
    summary: appendFollowUpSummary(reviewResult.summary, carriedForwardFindings.length),
    findings: [...carriedForwardFindings, ...reviewResult.findings],
    inlineFindings: [...carriedForwardFindings, ...reviewResult.inlineFindings],
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
