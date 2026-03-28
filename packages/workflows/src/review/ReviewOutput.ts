import { Effect, Schema } from "effect"

import { normalizePath } from "@open-azdo/core/paths"

import { ReviewOutputValidationError } from "../errors"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const ReviewResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "verdict", "findings", "unmappedNotes"],
  properties: {
    summary: {
      type: "string",
      minLength: 1,
    },
    verdict: {
      type: "string",
      enum: ["pass", "concerns", "fail"],
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "confidence", "title", "body", "filePath", "line"],
        properties: {
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
          },
          confidence: {
            type: "string",
            enum: ["low", "medium", "high"],
          },
          title: {
            type: "string",
            minLength: 1,
          },
          body: {
            type: "string",
            minLength: 1,
          },
          filePath: {
            type: "string",
            minLength: 1,
          },
          line: {
            type: "integer",
            minimum: 1,
          },
          endLine: {
            type: "integer",
            minimum: 1,
          },
          suggestion: {
            type: "string",
            minLength: 1,
          },
        },
      },
    },
    unmappedNotes: {
      type: "array",
      items: {
        type: "string",
      },
    },
  },
} as const

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
  readonly inlineFindings: ReviewFinding[]
  readonly summaryOnlyFindings: ReviewFinding[]
}

export const decodeReviewResult = (payload: unknown, changedLinesByFile: Map<string, Set<number>>) =>
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

export const renderUnmappedFinding = (finding: ReviewFinding) =>
  `${finding.title} (${finding.severity}, ${finding.confidence}) at ${normalizePath(finding.filePath)}:${finding.line}`

export const getFindingEndLine = (finding: ReviewFinding) => finding.endLine ?? finding.line

export const uniqueNotes = (notes: ReadonlyArray<string>) => [...new Set(notes)]
