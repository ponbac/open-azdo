import { Effect, Schema } from "effect"
import { ReviewOutputValidationError } from "../errors"
export declare const ReviewSeveritySchema: Schema.Literals<readonly ["low", "medium", "high", "critical"]>
export type ReviewSeverity = Schema.Schema.Type<typeof ReviewSeveritySchema>
export declare const ReviewConfidenceSchema: Schema.Literals<readonly ["low", "medium", "high"]>
export type ReviewConfidence = Schema.Schema.Type<typeof ReviewConfidenceSchema>
export declare const ReviewFindingSchema: Schema.Struct<{
  readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>
  readonly confidence: Schema.Literals<readonly ["low", "medium", "high"]>
  readonly title: Schema.String
  readonly body: Schema.String
  readonly filePath: Schema.String
  readonly line: Schema.Int
  readonly endLine: Schema.optionalKey<Schema.Int>
  readonly suggestion: Schema.optionalKey<Schema.String>
}>
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFindingSchema>
export declare const ReviewResultSchema: Schema.Struct<{
  readonly summary: Schema.String
  readonly verdict: Schema.Literals<readonly ["pass", "concerns", "fail"]>
  readonly findings: Schema.$Array<
    Schema.Struct<{
      readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>
      readonly confidence: Schema.Literals<readonly ["low", "medium", "high"]>
      readonly title: Schema.String
      readonly body: Schema.String
      readonly filePath: Schema.String
      readonly line: Schema.Int
      readonly endLine: Schema.optionalKey<Schema.Int>
      readonly suggestion: Schema.optionalKey<Schema.String>
    }>
  >
  readonly unmappedNotes: Schema.$Array<Schema.String>
}>
export type ReviewResult = Schema.Schema.Type<typeof ReviewResultSchema>
export type NormalizedReviewResult = ReviewResult & {
  readonly inlineFindings: ReviewFinding[]
  readonly summaryOnlyFindings: ReviewFinding[]
}
export declare const decodeReviewResult: (
  payload: unknown,
  changedLinesByFile: Map<string, Set<number>>,
) => Effect.Effect<NormalizedReviewResult, ReviewOutputValidationError, never>
export declare const normalizeReviewResult: (
  reviewResult: ReviewResult,
  changedLinesByFile: Map<string, Set<number>>,
) => NormalizedReviewResult
export declare const countBySeverity: (
  findings: ReadonlyArray<ReviewFinding>,
) => Record<"critical" | "high" | "low" | "medium", number>
export declare const renderUnmappedFinding: (finding: ReviewFinding) => string
export declare const getFindingEndLine: (finding: ReviewFinding) => number
export declare const uniqueNotes: (notes: ReadonlyArray<string>) => string[]
