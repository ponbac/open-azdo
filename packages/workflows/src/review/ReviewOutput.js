import { Effect, Schema } from "effect"
import { normalizePath } from "@open-azdo/core/paths"
import { ReviewOutputValidationError } from "../errors"
const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
export const ReviewSeveritySchema = Schema.Literals(["low", "medium", "high", "critical"])
export const ReviewConfidenceSchema = Schema.Literals(["low", "medium", "high"])
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
export const ReviewResultSchema = Schema.Struct({
  summary: NonEmptyString,
  verdict: Schema.Literals(["pass", "concerns", "fail"]),
  findings: Schema.Array(ReviewFindingSchema),
  unmappedNotes: Schema.Array(Schema.String),
})
export const decodeReviewResult = (payload, changedLinesByFile) =>
  Schema.decodeUnknownEffect(ReviewResultSchema)(payload).pipe(
    Effect.mapError(
      (error) =>
        new ReviewOutputValidationError({
          message: "Model output did not match the ReviewResult schema.",
          issues: [String(error)],
        }),
    ),
    Effect.map((decoded) => normalizeReviewResult(decoded, changedLinesByFile)),
  )
export const normalizeReviewResult = (reviewResult, changedLinesByFile) => {
  const unmappedNotes = [...reviewResult.unmappedNotes]
  const inlineFindings = []
  const summaryOnlyFindings = []
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
export const countBySeverity = (findings) => {
  const counts = {
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
export const renderUnmappedFinding = (finding) =>
  `${finding.title} (${finding.severity}, ${finding.confidence}) at ${normalizePath(finding.filePath)}:${finding.line}`
export const getFindingEndLine = (finding) => finding.endLine ?? finding.line
export const uniqueNotes = (notes) => [...new Set(notes)]
