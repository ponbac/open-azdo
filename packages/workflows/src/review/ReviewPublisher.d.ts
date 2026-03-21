import { Effect } from "effect"
import type { Redacted } from "effect"
import type { AzureContext } from "@open-azdo/azdo/context"
import { AzureDevOpsClient } from "@open-azdo/azdo/client"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import type { ReviewMode } from "./ReviewContext"
import type { ManagedReviewState, ThreadAction } from "./ThreadReconciliation"
import type { ReviewFinding } from "./ReviewOutput"
export type PublishReviewInput = {
  readonly context: AzureContext
  readonly token: Redacted.Redacted<string>
  readonly dryRun: boolean
  readonly summaryContent: string
  readonly inlineFindings: ReadonlyArray<ReviewFinding>
  readonly reviewMode: ReviewMode
  readonly scopedChangedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
  readonly scopedDeletedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>
}
export type PublishFailureSummaryInput = {
  readonly context: AzureContext
  readonly token: Redacted.Redacted<string>
  readonly dryRun: boolean
  readonly buildLink: string | undefined
  readonly existingThreads?: ReadonlyArray<ExistingThread> | undefined
  readonly failureReason: string
  readonly preservedSummaryState?: ManagedReviewState | undefined
}
export type PublishReviewResult = {
  readonly actions: ReadonlyArray<ThreadAction>
  readonly summaryContent: string
}
export declare const publishReview: ({
  context,
  token,
  dryRun,
  summaryContent,
  inlineFindings,
  reviewMode,
  scopedChangedLinesByFile,
  scopedDeletedLinesByFile,
}: PublishReviewInput) => Effect.Effect<PublishReviewResult, unknown, AzureDevOpsClient>
export declare const publishFailureSummary: ({
  context,
  token,
  dryRun,
  buildLink,
  existingThreads: providedExistingThreads,
  failureReason,
  preservedSummaryState,
}: PublishFailureSummaryInput) => Effect.Effect<void, unknown, AzureDevOpsClient>
