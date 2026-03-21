import { ServiceMap } from "effect"
import type { Effect, Redacted } from "effect"

import type { AzureContext } from "../context"
import type { AzureDevOpsDecodeError, AzureDevOpsHttpError } from "../errors"
import type { ExistingThread, PullRequestMetadata, PullRequestWorkItem, PullRequestWorkItemRef } from "../Schemas"

export type AzureRequestContext = {
  readonly context: AzureContext
  readonly token: Redacted.Redacted<string>
}

export type UpdateThreadStatusInput = AzureRequestContext & {
  readonly threadId: number
  readonly status: 1 | 2
}

export type UpdateCommentInput = AzureRequestContext & {
  readonly threadId: number
  readonly commentId: number
  readonly content: string
}

export type CreateThreadInput = AzureRequestContext & {
  readonly content: string
  readonly threadContext: Record<string, unknown> | undefined
}

export interface AzureDevOpsClientShape {
  readonly getPullRequestMetadata: (
    input: AzureRequestContext,
  ) => Effect.Effect<PullRequestMetadata, AzureDevOpsHttpError | AzureDevOpsDecodeError>
  readonly getPullRequestWorkItems: (
    input: AzureRequestContext & {
      readonly workItemRefs: ReadonlyArray<PullRequestWorkItemRef>
    },
  ) => Effect.Effect<ReadonlyArray<PullRequestWorkItem>, AzureDevOpsHttpError | AzureDevOpsDecodeError>
  readonly listThreads: (
    input: AzureRequestContext,
  ) => Effect.Effect<ReadonlyArray<ExistingThread>, AzureDevOpsHttpError | AzureDevOpsDecodeError>
  readonly updateThreadStatus: (
    input: UpdateThreadStatusInput,
  ) => Effect.Effect<void, AzureDevOpsHttpError | AzureDevOpsDecodeError>
  readonly updateComment: (
    input: UpdateCommentInput,
  ) => Effect.Effect<void, AzureDevOpsHttpError | AzureDevOpsDecodeError>
  readonly createThread: (
    input: CreateThreadInput,
  ) => Effect.Effect<void, AzureDevOpsHttpError | AzureDevOpsDecodeError>
}

export class AzureDevOpsClient extends ServiceMap.Service<AzureDevOpsClient, AzureDevOpsClientShape>()(
  "open-azdo/azdo/AzureDevOpsClient",
) {}
