import { Effect, Redacted } from "effect"
import { type AzureDevOpsClient, type AzureDevOpsClientShape } from "@open-azdo/azdo/client"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import { type ManagedReviewState } from "../src/review/ThreadReconciliation"
import type { NormalizedReviewResult, ReviewFinding } from "../src/review/ReviewOutput"
export declare const makeAzureContext: () => import("@open-azdo/azdo/context").AzureContext
export declare const withSilentLogs: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, never>>
export declare const makeReviewFinding: (overrides?: Partial<ReviewFinding>) => ReviewFinding
export declare const makeNormalizedReviewResult: (
  findings: ReadonlyArray<ReviewFinding>,
  inlineFindings?: ReadonlyArray<ReviewFinding>,
) => NormalizedReviewResult
export declare const makeManagedReviewState: (overrides?: Partial<ManagedReviewState>) => ManagedReviewState
export declare const makeSummarySnapshot: (
  overrides?: Record<string, unknown>,
  persistedState?: ManagedReviewState,
) => {
  verdict: "concerns" | "fail" | "pass"
  summary: string
  unmappedNotes: never[]
  severityCounts: {
    readonly critical: number
    readonly high: number
    readonly low: number
    readonly medium: number
  }
  persistedState: {
    readonly findingsCount: number
    readonly inlineFindingsCount: number
    readonly pullRequestBaseRef: string
    readonly reviewedCommit: string
    readonly schemaVersion: number
    readonly severityCounts: {
      readonly critical: number
      readonly high: number
      readonly low: number
      readonly medium: number
    }
    readonly unmappedNotesCount: number
    readonly verdict: "concerns" | "fail" | "pass"
  }
}
export declare const makeManagedSummaryThread: (reviewState?: ManagedReviewState, threadId?: number) => ExistingThread
export declare const makeManagedFindingThread: (
  finding: ReviewFinding,
  threadId?: number,
  status?: 1 | 2,
) => ExistingThread
export declare const makeAzureDevOpsClient: (
  overrides?: Partial<AzureDevOpsClientShape>,
) => AzureDevOpsClient["Service"]
export declare const systemToken: Redacted.Redacted<string>
export declare const extractManagedSummaryState: (thread: ExistingThread) =>
  | {
      readonly findingsCount: number
      readonly inlineFindingsCount: number
      readonly pullRequestBaseRef: string
      readonly reviewedCommit: string
      readonly schemaVersion: number
      readonly severityCounts: {
        readonly critical: number
        readonly high: number
        readonly low: number
        readonly medium: number
      }
      readonly unmappedNotesCount: number
      readonly verdict: "concerns" | "fail" | "pass"
    }
  | undefined
export declare const findingFingerprint: (finding: ReviewFinding) => string
