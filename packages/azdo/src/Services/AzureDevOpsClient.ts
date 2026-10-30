import { Context } from "effect"
import type { Effect, Redacted } from "effect"

import type { AzureContext } from "../context"
import type { AzureDevOpsDecodeError, AzureDevOpsHttpError } from "../errors"
import type { ExistingThread, PullRequestMetadata, PullRequestWorkItem, PullRequestWorkItemRef } from "../Schemas"

export type AzureRequestContext = {
  readonly context: AzureContext
  readonly token: Redacted.Redacted<string>
}

/** Azure DevOps pull-request thread status codes this client writes: `1` active, `2` fixed/resolved. */
export type WritableThreadStatus = 1 | 2

export type UpdateThreadStatusInput = AzureRequestContext & {
  readonly threadId: number
  readonly status: WritableThreadStatus
}

export type UpdateCommentInput = AzureRequestContext & {
  readonly threadId: number
  readonly commentId: number
  readonly content: string
}

/** File coordinates attached to a newly created pull-request discussion thread. */
export interface CreateThreadContext {
  readonly filePath?: string
  readonly leftFileStart?: { readonly line: number; readonly offset: number }
  readonly leftFileEnd?: { readonly line: number; readonly offset: number }
  readonly rightFileStart?: { readonly line: number; readonly offset: number }
  readonly rightFileEnd?: { readonly line: number; readonly offset: number }
}

export type CreateThreadInput = AzureRequestContext & {
  readonly content: string
  readonly threadContext: CreateThreadContext | undefined
  /** Azure DevOps thread status for the new thread. Defaults to `1` (active). */
  readonly status?: WritableThreadStatus | undefined
}

/** Azure DevOps operations and the precise failure algebra exposed to workflow callers. */
export interface AzureDevOpsClientService {
  /** Resolves the token's authenticated identity; failure cannot authorize existing managed comments. */
  readonly getAuthenticatedIdentity: (
    input: AzureRequestContext,
  ) => Effect.Effect<string, AzureDevOpsHttpError | AzureDevOpsDecodeError>
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

export class AzureDevOpsClient extends Context.Service<AzureDevOpsClient, AzureDevOpsClientService>()(
  "open-azdo/azdo/AzureDevOpsClient",
) {}
