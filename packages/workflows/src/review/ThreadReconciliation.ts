import { Schema } from "effect"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import { normalizePath } from "@open-azdo/core/paths"

import { countBySeverity, getFindingEndLine, type ReviewFinding, type ReviewResult } from "./ReviewOutput"

export const ManagedThreadMarkerSchema = Schema.Struct({
  kind: Schema.Literals(["summary", "finding"]),
  fingerprint: Schema.String,
})
export type ManagedThreadMarker = Schema.Schema.Type<typeof ManagedThreadMarkerSchema>

export type ThreadAction =
  | {
      readonly type: "upsert-summary"
      readonly marker: ManagedThreadMarker
      readonly content: string
      readonly existingThread: ExistingThread | undefined
      readonly commentId: number | undefined
    }
  | {
      readonly type: "upsert-finding"
      readonly marker: ManagedThreadMarker
      readonly content: string
      readonly finding: ReviewFinding
      readonly existingThread: ExistingThread | undefined
      readonly commentId: number | undefined
    }
  | {
      readonly type: "close-thread"
      readonly marker: ManagedThreadMarker
      readonly existingThread: ExistingThread
    }

const MARKER_PREFIX = "<!-- open-azdo:"
const MARKER_SUFFIX = " -->"
const SUMMARY_FINGERPRINT = "summary"

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

export const encodeMarker = (marker: ManagedThreadMarker) => `${MARKER_PREFIX}${JSON.stringify(marker)}${MARKER_SUFFIX}`

export const decodeMarker = (content: unknown): ManagedThreadMarker | undefined => {
  if (typeof content !== "string") {
    return undefined
  }

  const start = content.indexOf(MARKER_PREFIX)
  const end = content.indexOf(MARKER_SUFFIX, start)

  if (start === -1 || end === -1) {
    return undefined
  }

  try {
    return Schema.decodeUnknownSync(ManagedThreadMarkerSchema)(
      JSON.parse(content.slice(start + MARKER_PREFIX.length, end)),
    )
  } catch {
    return undefined
  }
}

const listManagedThreadComments = (existingThreads: ReadonlyArray<ExistingThread>) => {
  const managed: Array<{
    readonly thread: ExistingThread
    readonly commentId: number
    readonly marker: ManagedThreadMarker
  }> = []

  for (const thread of existingThreads) {
    for (const comment of thread.comments) {
      const marker = decodeMarker(comment.content)
      if (!marker) {
        continue
      }

      managed.push({
        thread,
        commentId: comment.id,
        marker,
      })
      break
    }
  }

  return managed
}

export const findManagedSummaryThread = (existingThreads: ReadonlyArray<ExistingThread>) => {
  for (const { thread, commentId, marker } of listManagedThreadComments(existingThreads)) {
    if (marker.kind === "summary") {
      return {
        thread,
        commentId,
      }
    }
  }

  return undefined
}

export const buildSummaryComment = (reviewResult: ReviewResult, buildLink?: string) => {
  const counts = countBySeverity(reviewResult.findings)
  const lines = [
    `Verdict: **${reviewResult.verdict}**`,
    "",
    reviewResult.summary,
    "",
    `Severity counts: critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low}.`,
  ]

  if (reviewResult.unmappedNotes.length > 0) {
    lines.push("", "Summary-only notes:")
    for (const note of reviewResult.unmappedNotes) {
      lines.push(`- ${note}`)
    }
  }

  if (buildLink) {
    lines.push("", `Build: ${buildLink}`)
  }

  lines.push("", encodeMarker({ kind: "summary", fingerprint: SUMMARY_FINGERPRINT }))
  return lines.join("\n")
}

export const buildInlineComment = (finding: ReviewFinding) =>
  [
    `**${finding.title}**`,
    "",
    `Severity: ${finding.severity}`,
    `Confidence: ${finding.confidence}`,
    "",
    finding.body,
    finding.suggestion ? `\nSuggestion:\n\n${finding.suggestion}` : "",
    "",
    encodeMarker({ kind: "finding", fingerprint: fingerprintFinding(finding) }),
  ]
    .filter(Boolean)
    .join("\n")

export const reconcileThreads = (
  existingThreads: ReadonlyArray<ExistingThread>,
  reviewResult: ReviewResult,
  inlineFindings: ReadonlyArray<ReviewFinding>,
  buildLink?: string,
): ThreadAction[] => {
  const actions: ThreadAction[] = []
  const managed = new Map<
    string,
    { readonly thread: ExistingThread; readonly commentId: number | undefined; readonly marker: ManagedThreadMarker }
  >()

  for (const { thread, commentId, marker } of listManagedThreadComments(existingThreads)) {
    managed.set(`${marker.kind}:${marker.fingerprint}`, {
      thread,
      commentId,
      marker,
    })
  }

  const summaryMarker: ManagedThreadMarker = { kind: "summary", fingerprint: SUMMARY_FINGERPRINT }
  const existingSummary = managed.get(`${summaryMarker.kind}:${summaryMarker.fingerprint}`)

  actions.push({
    type: "upsert-summary",
    marker: summaryMarker,
    content: buildSummaryComment(reviewResult, buildLink),
    existingThread: existingSummary?.thread,
    commentId: existingSummary?.commentId,
  })

  const activeFindingKeys = new Set<string>()

  for (const finding of inlineFindings) {
    const marker: ManagedThreadMarker = { kind: "finding", fingerprint: fingerprintFinding(finding) }
    const key = `${marker.kind}:${marker.fingerprint}`
    activeFindingKeys.add(key)

    const existing = managed.get(key)
    actions.push({
      type: "upsert-finding",
      marker,
      content: buildInlineComment(finding),
      finding,
      existingThread: existing?.thread,
      commentId: existing?.commentId,
    })
  }

  for (const [key, existing] of managed.entries()) {
    if (existing.marker.kind !== "finding" || activeFindingKeys.has(key)) {
      continue
    }

    actions.push({
      type: "close-thread",
      marker: existing.marker,
      existingThread: existing.thread,
    })
  }

  return actions
}
