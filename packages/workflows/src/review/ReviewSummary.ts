import { Effect, Schema } from "effect"

import { normalizePath } from "@open-azdo/core/paths"

import { ReviewOutputValidationError } from "../errors"
import {
  type NormalizedReviewResult,
  ReviewConfidenceSchema,
  type ReviewFinding,
  ReviewSeveritySchema,
} from "./ReviewOutput"
import { fingerprintFinding } from "./ThreadReconciliation"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const ReviewSummarySubjectKindSchema = Schema.Literals([
  "inline-finding",
  "summary-only-finding",
  "unmapped-note",
  "carried-forward-finding",
])
export type ReviewSummarySubjectKind = Schema.Schema.Type<typeof ReviewSummarySubjectKindSchema>

export const ReviewSummarySubjectSchema = Schema.Struct({
  id: NonEmptyString,
  kind: ReviewSummarySubjectKindSchema,
  title: NonEmptyString,
  body: Schema.optionalKey(NonEmptyString),
  severity: Schema.optionalKey(ReviewSeveritySchema),
  confidence: Schema.optionalKey(ReviewConfidenceSchema),
  filePath: Schema.optionalKey(NonEmptyString),
  line: Schema.optionalKey(PositiveInt),
})
export type ReviewSummarySubject = Schema.Schema.Type<typeof ReviewSummarySubjectSchema>

export const ReviewSummaryHighlightSchema = Schema.Struct({
  subjectIds: Schema.Array(NonEmptyString),
  text: NonEmptyString,
})
export type ReviewSummaryHighlight = Schema.Schema.Type<typeof ReviewSummaryHighlightSchema>

export const ReviewSummaryPassOutputSchema = Schema.Struct({
  highlights: Schema.Array(ReviewSummaryHighlightSchema),
})
export type ReviewSummaryPassOutput = Schema.Schema.Type<typeof ReviewSummaryPassOutputSchema>

export const ReviewSummaryPassOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["highlights"],
  properties: {
    highlights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subjectIds", "text"],
        properties: {
          subjectIds: {
            type: "array",
            items: {
              type: "string",
              minLength: 1,
            },
          },
          text: {
            type: "string",
            minLength: 1,
          },
        },
      },
    },
  },
} as const

type ReviewSummaryCounts = {
  readonly findings: number
  readonly summaryOnlyNotes: number
  readonly carriedForwardFindings: number
}

export type ReviewSummaryValidationResult =
  | {
      readonly ok: true
      readonly output: ReviewSummaryPassOutput
    }
  | {
      readonly ok: false
      readonly issues: ReadonlyArray<string>
    }

const createFindingSubject = (
  id: string,
  kind: Exclude<ReviewSummarySubjectKind, "unmapped-note">,
  finding: ReviewFinding,
): ReviewSummarySubject => ({
  id,
  kind,
  title: finding.title,
  body: finding.body,
  severity: finding.severity,
  confidence: finding.confidence,
  filePath: normalizePath(finding.filePath),
  line: finding.line,
})

const createUnmappedNoteSubject = (id: string, note: string): ReviewSummarySubject => ({
  id,
  kind: "unmapped-note",
  title: note,
  body: note,
})

/**
 * Builds the summary-pass subject list from the normalized result that will actually be published.
 * Carry-forward findings are passed separately so they can stay explicit and cannot be confused with
 * newly discovered issues during the summary render.
 */
export const buildReviewSummarySubjects = ({
  reviewResult,
  carriedForwardFindings,
}: {
  readonly reviewResult: NormalizedReviewResult
  readonly carriedForwardFindings?: ReadonlyArray<ReviewFinding> | undefined
}): ReadonlyArray<ReviewSummarySubject> => {
  const subjects: ReviewSummarySubject[] = []
  const carriedForwardFingerprints = new Set(
    (carriedForwardFindings ?? []).map((finding) => fingerprintFinding(finding)),
  )

  let inlineFindingIndex = 1
  for (const finding of reviewResult.inlineFindings) {
    if (carriedForwardFingerprints.has(fingerprintFinding(finding))) {
      continue
    }

    subjects.push(createFindingSubject(`inline-finding-${inlineFindingIndex}`, "inline-finding", finding))
    inlineFindingIndex += 1
  }

  let summaryOnlyFindingIndex = 1
  for (const finding of reviewResult.summaryOnlyFindings) {
    subjects.push(
      createFindingSubject(`summary-only-finding-${summaryOnlyFindingIndex}`, "summary-only-finding", finding),
    )
    summaryOnlyFindingIndex += 1
  }

  let unmappedNoteIndex = 1
  for (const note of reviewResult.unmappedNotes) {
    subjects.push(createUnmappedNoteSubject(`unmapped-note-${unmappedNoteIndex}`, note))
    unmappedNoteIndex += 1
  }

  let carriedForwardFindingIndex = 1
  for (const finding of carriedForwardFindings ?? []) {
    subjects.push(
      createFindingSubject(`carried-forward-finding-${carriedForwardFindingIndex}`, "carried-forward-finding", finding),
    )
    carriedForwardFindingIndex += 1
  }

  return subjects
}

export const decodeReviewSummaryPassOutput = (payload: unknown) =>
  Schema.decodeUnknownEffect(ReviewSummaryPassOutputSchema)(payload).pipe(
    Effect.mapError(
      (error) =>
        new ReviewOutputValidationError({
          message: "Model output did not match the ReviewSummaryPassOutput schema.",
          issues: [String(error)],
        }),
    ),
  )

const countSummarySubjects = (subjects: ReadonlyArray<ReviewSummarySubject>): ReviewSummaryCounts => ({
  findings: subjects.filter((subject) => subject.kind !== "unmapped-note").length,
  summaryOnlyNotes: subjects.filter((subject) => subject.kind === "unmapped-note").length,
  carriedForwardFindings: subjects.filter((subject) => subject.kind === "carried-forward-finding").length,
})

const formatCount = (count: number, singular: string, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`

/**
 * Produces the deterministic lead sentence that every published summary starts with, regardless of
 * whether the grouped highlights came from the model or the fallback renderer.
 */
export const renderReviewSummaryOverview = ({
  verdict,
  subjects,
}: {
  readonly verdict: NormalizedReviewResult["verdict"]
  readonly subjects: ReadonlyArray<ReviewSummarySubject>
}) => {
  const counts = countSummarySubjects(subjects)

  if (counts.findings === 0 && counts.summaryOnlyNotes === 0) {
    return `✅ This review is ${verdict} with no publishable findings or summary-only notes.`
  }

  const parts: string[] = []

  if (counts.findings > 0) {
    parts.push(formatCount(counts.findings, "finding"))
  }

  if (counts.summaryOnlyNotes > 0) {
    parts.push(formatCount(counts.summaryOnlyNotes, "summary-only note"))
  }

  const overview = `This review is ${verdict} with ${parts.join(" and ")}.`

  if (counts.carriedForwardFindings === 0) {
    return overview
  }

  return `${overview} ${formatCount(counts.carriedForwardFindings, "finding")} ${counts.carriedForwardFindings === 1 ? "is" : "are"} carried forward from earlier managed reviews outside this follow-up diff.`
}

const renderSubjectLocation = (subject: ReviewSummarySubject) =>
  subject.filePath && subject.line ? `${subject.filePath}:${subject.line}` : subject.filePath

const renderSubjectFallbackText = (subject: ReviewSummarySubject) => {
  const location = renderSubjectLocation(subject)
  const locationSuffix = location ? ` (${location})` : ""

  if (subject.kind === "carried-forward-finding") {
    return `Still tracking: ${subject.title}${locationSuffix}`
  }

  return `${subject.title}${locationSuffix}`
}

const renderSummaryHighlights = (highlights: ReadonlyArray<{ readonly text: string }>) =>
  highlights.map((highlight) => `- ${highlight.text.trim()}`).join("\n")

export const renderReviewSummaryFromHighlights = ({
  verdict,
  subjects,
  output,
}: {
  readonly verdict: NormalizedReviewResult["verdict"]
  readonly subjects: ReadonlyArray<ReviewSummarySubject>
  readonly output: ReviewSummaryPassOutput
}) => {
  const overview = renderReviewSummaryOverview({ verdict, subjects })
  const highlightBlock = renderSummaryHighlights(output.highlights)

  return highlightBlock.length > 0 ? `${overview}\n\n${highlightBlock}` : overview
}

/**
 * Renders the plain fallback summary used when the summary pass is skipped or rejected.
 * The output is intentionally simple and can only mention the validated subject list.
 */
export const renderReviewSummaryFallback = ({
  verdict,
  subjects,
}: {
  readonly verdict: NormalizedReviewResult["verdict"]
  readonly subjects: ReadonlyArray<ReviewSummarySubject>
}) => {
  const overview = renderReviewSummaryOverview({ verdict, subjects })

  if (subjects.length === 0) {
    return overview
  }

  return `${overview}\n\n${subjects.map((subject) => `- ${renderSubjectFallbackText(subject)}`).join("\n")}`
}

export const validateReviewSummaryPassOutput = ({
  subjects,
  output,
}: {
  readonly subjects: ReadonlyArray<ReviewSummarySubject>
  readonly output: ReviewSummaryPassOutput
}): ReviewSummaryValidationResult => {
  const subjectIds = new Set(subjects.map((subject) => subject.id))
  const seenSubjectIds = new Set<string>()
  const issues: string[] = []

  if (subjects.length > 0 && output.highlights.length === 0) {
    issues.push("Summary output must contain at least one highlight when summary subjects exist.")
  }

  for (const [index, highlight] of output.highlights.entries()) {
    if (highlight.subjectIds.length === 0) {
      issues.push(`Highlight ${index + 1} must reference at least one subject ID.`)
      continue
    }

    for (const subjectId of highlight.subjectIds) {
      if (!subjectIds.has(subjectId)) {
        issues.push(`Highlight ${index + 1} referenced unknown subject ID ${subjectId}.`)
      }

      if (seenSubjectIds.has(subjectId)) {
        issues.push(`Subject ID ${subjectId} appeared in more than one highlight.`)
        continue
      }

      seenSubjectIds.add(subjectId)
    }
  }

  return issues.length === 0 ? { ok: true, output } : { ok: false, issues }
}
