import { Schema } from "effect"

import { ExistingThreadSchema, PullRequestWorkItemSchema } from "@open-azdo/azdo/schemas"
import type { ThreadAction } from "@open-azdo/workflows/review"

const LineRangeSchema = Schema.Struct({
  start: Schema.Int,
  end: Schema.Int,
})

const ReviewFindingSchema = Schema.Struct({
  severity: Schema.Literals(["low", "medium", "high", "critical"]),
  confidence: Schema.Literals(["low", "medium", "high"]),
  title: Schema.String,
  body: Schema.String,
  filePath: Schema.String,
  line: Schema.Int,
  endLine: Schema.optionalKey(Schema.Int),
  suggestion: Schema.optionalKey(Schema.String),
})

const ReviewHistoryTokensSchema = Schema.Struct({
  input: Schema.Int,
  output: Schema.Int,
  reasoning: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
})

const ReviewHistoryEntrySchema = Schema.Struct({
  reviewedCommit: Schema.String,
  reviewedAt: Schema.optionalKey(Schema.String),
  reviewMode: Schema.Literals(["full", "follow-up"]),
  model: Schema.String,
  variant: Schema.optionalKey(Schema.String),
  buildNumber: Schema.optionalKey(Schema.String),
  buildId: Schema.optionalKey(Schema.String),
  buildLink: Schema.optionalKey(Schema.String),
  costUsd: Schema.optionalKey(Schema.Number),
  tokens: Schema.optionalKey(ReviewHistoryTokensSchema),
})

const ManagedReviewStateSchema = Schema.Struct({
  schemaVersion: Schema.Int,
  reviewedCommit: Schema.String,
  pullRequestBaseRef: Schema.String,
  verdict: Schema.Literals(["pass", "concerns", "fail"]),
  severityCounts: Schema.Struct({
    low: Schema.Int,
    medium: Schema.Int,
    high: Schema.Int,
    critical: Schema.Int,
  }),
  findingsCount: Schema.Int,
  inlineFindingsCount: Schema.Int,
  unmappedNotesCount: Schema.Int,
  reviewHistory: Schema.optionalKey(Schema.Array(ReviewHistoryEntrySchema)),
})

const PullRequestMetadataSchema = Schema.Struct({
  pullRequestId: Schema.optionalKey(Schema.Int),
  title: Schema.String,
  description: Schema.String,
  url: Schema.optionalKey(Schema.String),
  sourceRefName: Schema.optionalKey(Schema.String),
  targetRefName: Schema.optionalKey(Schema.String),
  createdByDisplayName: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
      remoteUrl: Schema.optionalKey(Schema.String),
      webUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  sourceCommitId: Schema.optionalKey(Schema.String),
  workItemRefs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      url: Schema.optionalKey(Schema.String),
    }),
  ),
})

const OpenCodeUsageSchema = Schema.Struct({
  costUsd: Schema.optionalKey(Schema.Number),
  tokens: Schema.optionalKey(
    Schema.Struct({
      input: Schema.Int,
      output: Schema.Int,
      reasoning: Schema.Int,
      cacheRead: Schema.Int,
      cacheWrite: Schema.Int,
    }),
  ),
})

const ReviewSummarySubjectSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["inline-finding", "summary-only-finding", "unmapped-note", "carried-forward-finding"]),
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  severity: Schema.optionalKey(Schema.Literals(["low", "medium", "high", "critical"])),
  confidence: Schema.optionalKey(Schema.Literals(["low", "medium", "high"])),
  filePath: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Int),
})

const ReviewSummaryPassOutputSchema = Schema.Struct({
  highlights: Schema.Array(
    Schema.Struct({
      subjectIds: Schema.Array(Schema.String),
      text: Schema.String,
    }),
  ),
})

const OpenCodeResultSchema = Schema.Struct({
  response: Schema.String,
  structured: Schema.optionalKey(Schema.Unknown),
  modelError: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      message: Schema.String,
      retries: Schema.optionalKey(Schema.Int),
    }),
  ),
  sessionId: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(OpenCodeUsageSchema),
})

const NormalizedReviewResultSchema = Schema.Struct({
  verdict: Schema.Literals(["pass", "concerns", "fail"]),
  findings: Schema.Array(ReviewFindingSchema),
  inlineFindings: Schema.Array(ReviewFindingSchema),
  summaryOnlyFindings: Schema.Array(ReviewFindingSchema),
  unmappedNotes: Schema.Array(Schema.String),
})

const SandboxPreviewActionSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("upsert-summary"),
    content: Schema.String,
    existingThreadId: Schema.optionalKey(Schema.Int),
    commentId: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    type: Schema.Literal("upsert-finding"),
    content: Schema.String,
    finding: ReviewFindingSchema,
    existingThreadId: Schema.optionalKey(Schema.Int),
    commentId: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    type: Schema.Literal("close-thread"),
    existingThreadId: Schema.Int,
  }),
])

export type SandboxPreviewAction = Schema.Schema.Type<typeof SandboxPreviewActionSchema>

export const SandboxThreadSchema = ExistingThreadSchema
export type SandboxThread = Schema.Schema.Type<typeof SandboxThreadSchema>

export const SandboxCaptureSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  capturedAt: Schema.String,
  workspaceMode: Schema.Literals(["provided", "temporary"]),
  target: Schema.Struct({
    organization: Schema.String,
    project: Schema.String,
    collectionUrl: Schema.String,
    repositoryId: Schema.String,
    pullRequestId: Schema.Int,
  }),
  metadata: PullRequestMetadataSchema,
  workItems: Schema.Array(PullRequestWorkItemSchema),
  baselineThreads: Schema.Array(ExistingThreadSchema),
  diff: Schema.Struct({
    baseRef: Schema.String,
    headRef: Schema.String,
    diffText: Schema.String,
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        patch: Schema.String,
        changedLineRanges: Schema.Array(LineRangeSchema),
      }),
    ),
  }),
  review: Schema.Struct({
    mode: Schema.Literals(["full", "follow-up", "skipped"]),
    prompt: Schema.optionalKey(Schema.String),
    resultSource: Schema.optionalKey(Schema.Literals(["structured", "repaired", "fallback"])),
    openCodeResult: Schema.optionalKey(OpenCodeResultSchema),
    result: Schema.optionalKey(NormalizedReviewResultSchema),
    summaryPass: Schema.Struct({
      prompt: Schema.optionalKey(Schema.String),
      resultSource: Schema.optionalKey(Schema.Literals(["structured", "repaired", "fallback"])),
      openCodeResult: Schema.optionalKey(OpenCodeResultSchema),
      result: Schema.optionalKey(ReviewSummaryPassOutputSchema),
      fallbackUsed: Schema.Boolean,
      subjects: Schema.Array(ReviewSummarySubjectSchema),
    }),
    summaryState: ManagedReviewStateSchema,
    summaryContent: Schema.String,
    actions: Schema.Array(SandboxPreviewActionSchema),
    previewThreads: Schema.Array(ExistingThreadSchema),
  }),
})
export type SandboxCapture = Schema.Schema.Type<typeof SandboxCaptureSchema>
export const decodeSandboxCapture = Schema.decodeUnknownSync(SandboxCaptureSchema)

export const toSandboxPreviewAction = (action: ThreadAction): SandboxPreviewAction => {
  switch (action.type) {
    case "upsert-summary":
      return {
        type: action.type,
        content: action.content,
        ...(action.existingThread ? { existingThreadId: action.existingThread.id } : {}),
        ...(action.commentId !== undefined ? { commentId: action.commentId } : {}),
      }
    case "upsert-finding":
      return {
        type: action.type,
        content: action.content,
        finding: action.finding,
        ...(action.existingThread ? { existingThreadId: action.existingThread.id } : {}),
        ...(action.commentId !== undefined ? { commentId: action.commentId } : {}),
      }
    case "close-thread":
      return {
        type: action.type,
        existingThreadId: action.existingThread.id,
      }
  }
}

const nextPreviewThreadId = (threads: ReadonlyArray<SandboxThread>) =>
  Math.min(0, ...threads.map((thread) => thread.id)) - 1

const appendPreviewComment = (
  comments: SandboxThread["comments"],
  commentId: number,
  content: string,
): SandboxThread["comments"] => [
  ...comments.filter((comment) => comment.id !== commentId),
  {
    id: commentId,
    content,
    author: {
      displayName: "open-azdo sandbox",
    },
    publishedDate: new Date().toISOString(),
    isDeleted: false,
    commentType: 1,
  },
]

const upsertPreviewThread = ({
  threads,
  existingThreadId,
  commentId,
  content,
  threadContext,
}: {
  readonly threads: SandboxThread[]
  readonly existingThreadId: number | undefined
  readonly commentId: number | undefined
  readonly content: string
  readonly threadContext?: SandboxThread["threadContext"]
}) => {
  if (existingThreadId !== undefined) {
    const index = threads.findIndex((thread) => thread.id === existingThreadId)
    const existing = index >= 0 ? threads[index] : undefined
    if (index >= 0 && existing) {
      threads[index] = {
        ...existing,
        status: 1,
        comments: appendPreviewComment(existing.comments, commentId ?? -1, content),
      }
      return
    }
  }

  threads.push({
    id: nextPreviewThreadId(threads),
    status: 1,
    comments: appendPreviewComment([], -1, content),
    ...(threadContext ? { threadContext } : {}),
  })
}

export const projectPreviewThreads = (
  baselineThreads: ReadonlyArray<SandboxThread>,
  actions: ReadonlyArray<SandboxPreviewAction>,
): SandboxThread[] => {
  const threads: SandboxThread[] = [...baselineThreads]

  for (const action of actions) {
    switch (action.type) {
      case "upsert-summary": {
        upsertPreviewThread({
          threads,
          existingThreadId: action.existingThreadId,
          commentId: action.commentId,
          content: action.content,
        })
        break
      }
      case "upsert-finding": {
        upsertPreviewThread({
          threads,
          existingThreadId: action.existingThreadId,
          commentId: action.commentId,
          content: action.content,
          threadContext: {
            filePath: `/${action.finding.filePath}`,
            rightFileStart: {
              line: action.finding.line,
              offset: 1,
            },
            rightFileEnd: {
              line: action.finding.endLine ?? action.finding.line,
              offset: 1,
            },
          },
        })
        break
      }
      case "close-thread": {
        const index = threads.findIndex((thread) => thread.id === action.existingThreadId)
        const existing = index >= 0 ? threads[index] : undefined
        if (index >= 0 && existing) {
          threads[index] = {
            ...existing,
            status: 2,
          }
        }
        break
      }
    }
  }

  return threads
}
