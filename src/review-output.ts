import { Effect, Option, Schema } from "effect"

import { ReviewOutputValidationError } from "./errors"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const ReviewSeveritySchema = Schema.Literals(["low", "medium", "high", "critical"])
export type ReviewSeverity = Schema.Schema.Type<typeof ReviewSeveritySchema>

export const ReviewConfidenceSchema = Schema.Literals(["low", "medium", "high"])
export type ReviewConfidence = Schema.Schema.Type<typeof ReviewConfidenceSchema>

export const ReviewFindingSchema = Schema.Struct({
  severity: ReviewSeveritySchema,
  confidence: ReviewConfidenceSchema,
  title: NonEmptyString,
  body: NonEmptyString,
  filePath: NonEmptyString,
  line: PositiveInt,
  endLine: Schema.optionalKey(PositiveInt),
  suggestion: Schema.optionalKey(NonEmptyString),
})
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFindingSchema>

export const ReviewResultSchema = Schema.Struct({
  summary: NonEmptyString,
  verdict: Schema.Literals(["pass", "concerns", "fail"]),
  findings: Schema.Array(ReviewFindingSchema),
  unmappedNotes: Schema.Array(Schema.String),
})
export type ReviewResult = Schema.Schema.Type<typeof ReviewResultSchema>

export type NormalizedReviewResult = ReviewResult & {
  inlineFindings: ReviewFinding[]
  summaryOnlyFindings: ReviewFinding[]
}

export const decodeReviewResult = Effect.fn("reviewOutput.decodeReviewResult")(function* (
  payload: unknown,
  changedLinesByFile: Map<string, Set<number>>,
) {
  const decoded = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(ReviewResultSchema)(payload),
    catch: (error) =>
      new ReviewOutputValidationError({
        message: "Model output did not match the ReviewResult schema.",
        issues: [String(error)],
      }),
  })

  return normalizeReviewResult(decoded, changedLinesByFile)
})

export const normalizeReviewResult = (
  reviewResult: ReviewResult,
  changedLinesByFile: Map<string, Set<number>>,
): NormalizedReviewResult => {
  const unmappedNotes = [...reviewResult.unmappedNotes]
  const inlineFindings: ReviewFinding[] = []
  const summaryOnlyFindings: ReviewFinding[] = []

  for (const finding of reviewResult.findings) {
    const changedLines = changedLinesByFile.get(normalizePath(finding.filePath))
    const isChangedLine = changedLines?.has(finding.line) ?? false

    if (!changedLines || !isChangedLine) {
      summaryOnlyFindings.push(finding)
      unmappedNotes.push(renderUnmappedFinding(finding))
      continue
    }

    if (finding.confidence === "low") {
      summaryOnlyFindings.push(finding)
      continue
    }

    inlineFindings.push(finding)
  }

  return {
    ...reviewResult,
    inlineFindings,
    summaryOnlyFindings,
    unmappedNotes: uniqueNotes(unmappedNotes),
  }
}

export const countBySeverity = (findings: ReadonlyArray<ReviewFinding>) => {
  const counts: Record<ReviewSeverity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  }

  for (const finding of findings) {
    counts[finding.severity] += 1
  }

  return counts
}

export const normalizePath = (value: string) => value.replaceAll("\\", "/").replace(/^\.\/+/, "")

export const renderUnmappedFinding = (finding: ReviewFinding) =>
  `${finding.title} (${finding.severity}, ${finding.confidence}) at ${normalizePath(finding.filePath)}:${finding.line}`

export const getFindingEndLine = (finding: ReviewFinding) =>
  Option.getOrElse(Option.fromNullishOr(finding.endLine), () => finding.line)

export const uniqueNotes = (notes: ReadonlyArray<string>) => [...new Set(notes)]
