import { Schema } from "effect"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import { type NormalizedReviewResult, type ReviewFinding, type ReviewResult } from "./ReviewOutput"
import type { ReviewMode } from "./ReviewContext"
declare const SeverityCountsSchema: Schema.Struct<{
  readonly low: Schema.Int
  readonly medium: Schema.Int
  readonly high: Schema.Int
  readonly critical: Schema.Int
}>
export type SeverityCounts = Schema.Schema.Type<typeof SeverityCountsSchema>
export declare const ManagedReviewStateSchema: Schema.Struct<{
  readonly schemaVersion: Schema.Int
  readonly reviewedCommit: Schema.String
  readonly pullRequestBaseRef: Schema.String
  readonly verdict: Schema.Literals<readonly ["pass", "concerns", "fail"]>
  readonly severityCounts: Schema.Struct<{
    readonly low: Schema.Int
    readonly medium: Schema.Int
    readonly high: Schema.Int
    readonly critical: Schema.Int
  }>
  readonly findingsCount: Schema.Int
  readonly inlineFindingsCount: Schema.Int
  readonly unmappedNotesCount: Schema.Int
}>
export type ManagedReviewState = Schema.Schema.Type<typeof ManagedReviewStateSchema>
export declare const SKIPPED_REVIEW_SUMMARY =
  "\u23ED\uFE0F No new commits since the last managed review. Previous verdict still applies."
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
export declare const fingerprintFinding: (finding: ReviewFinding) => string
export declare const buildManagedReviewState: ({
  reviewedCommit,
  pullRequestBaseRef,
  reviewResult,
}: {
  readonly reviewedCommit: string
  readonly pullRequestBaseRef: string
  readonly reviewResult: ReviewResult & {
    readonly inlineFindings?: ReadonlyArray<ReviewFinding>
  }
}) => ManagedReviewState
export declare const buildSummaryComment: (snapshot: SummarySnapshot) => string
export declare const buildInlineComment: (finding: ReviewFinding) => string
type ExistingSummaryThread = {
  readonly thread: ExistingThread
  readonly commentId: number
  readonly reviewState: ManagedReviewState
}
export declare const findManagedSummaryThread: (
  existingThreads: ReadonlyArray<ExistingThread>,
) => ExistingSummaryThread | undefined
export declare const mergeFollowUpReviewResult: ({
  existingThreads,
  scopedChangedLinesByFile,
  scopedDeletedLinesByFile,
  reviewResult,
}: {
  readonly existingThreads: ReadonlyArray<ExistingThread>
  readonly scopedChangedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
  readonly scopedDeletedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
  readonly reviewResult: NormalizedReviewResult
}) => NormalizedReviewResult
export declare const reconcileThreads: ({
  existingThreads,
  summaryContent,
  inlineFindings,
  reviewMode,
  scopedChangedLinesByFile,
  scopedDeletedLinesByFile,
}: ReconcileThreadsInput) => ThreadAction[]
export {}
