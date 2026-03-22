import { Schema } from "effect"

export const PullRequestWorkItemRefSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type PullRequestWorkItemRef = {
  readonly id: string
  readonly url?: string | undefined
}

export const PullRequestMetadataResponseSchema = Schema.Struct({
  title: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  workItemRefs: Schema.optionalKey(Schema.Array(PullRequestWorkItemRefSchema)),
})

export const PullRequestWorkItemsResponseSchema = Schema.Array(PullRequestWorkItemRefSchema)

export type PullRequestMetadata = {
  readonly title: string
  readonly description: string
  readonly url?: string | undefined
  readonly workItemRefs: ReadonlyArray<PullRequestWorkItemRef>
}

const ExistingThreadStatusSchema = Schema.Union([
  Schema.Int,
  Schema.Literal("active"),
  Schema.Literal("fixed"),
  Schema.Literal("wontFix"),
  Schema.Literal("closed"),
  Schema.Literal("byDesign"),
  Schema.Literal("pending"),
])

const NullableIntSchema = Schema.NullOr(Schema.Int)

export const ExistingThreadSchema = Schema.Struct({
  id: Schema.Int,
  status: Schema.optionalKey(Schema.NullOr(ExistingThreadStatusSchema)),
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      content: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
  threadContext: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        filePath: Schema.optionalKey(Schema.String),
        rightFileStart: Schema.optionalKey(
          Schema.Struct({
            line: Schema.optionalKey(NullableIntSchema),
            offset: Schema.optionalKey(NullableIntSchema),
          }),
        ),
        rightFileEnd: Schema.optionalKey(
          Schema.Struct({
            line: Schema.optionalKey(NullableIntSchema),
            offset: Schema.optionalKey(NullableIntSchema),
          }),
        ),
      }),
    ),
  ),
})
export type ExistingThread = Schema.Schema.Type<typeof ExistingThreadSchema>

export const ExistingThreadsResponseSchema = Schema.Struct({
  value: Schema.optionalKey(Schema.Array(ExistingThreadSchema)),
})
export type ExistingThreadsResponse = Schema.Schema.Type<typeof ExistingThreadsResponseSchema>

const WorkItemAssignedToSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  Schema.Null,
])

const WorkItemRelationSchema = Schema.Struct({
  rel: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  attributes: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
})

export const WorkItemBatchItemSchema = Schema.Struct({
  id: Schema.Int,
  fields: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  relations: Schema.optionalKey(Schema.NullOr(Schema.Array(WorkItemRelationSchema))),
})
export type WorkItemBatchItem = Schema.Schema.Type<typeof WorkItemBatchItemSchema>

export const WorkItemsBatchResponseSchema = Schema.Struct({
  value: Schema.optionalKey(Schema.Array(WorkItemBatchItemSchema)),
})
export type WorkItemsBatchResponse = Schema.Schema.Type<typeof WorkItemsBatchResponseSchema>

const WorkItemIdentitySchema = Schema.Struct({
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export const WorkItemCommentSchema = Schema.Struct({
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  renderedText: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isDeleted: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  createdBy: Schema.optionalKey(Schema.NullOr(WorkItemIdentitySchema)),
})
export type WorkItemComment = Schema.Schema.Type<typeof WorkItemCommentSchema>

export const WorkItemCommentsResponseSchema = Schema.Struct({
  comments: Schema.optionalKey(Schema.Array(WorkItemCommentSchema)),
})
export type WorkItemCommentsResponse = Schema.Schema.Type<typeof WorkItemCommentsResponseSchema>

export type PullRequestWorkItem = {
  readonly id: number
  readonly title: string
  readonly workItemType: string
  readonly state: string
  readonly priority?: number | undefined
  readonly assignedTo?: string | undefined
  readonly iterationPath?: string | undefined
  readonly areaPath?: string | undefined
  readonly tags: ReadonlyArray<string>
  readonly descriptionMarkdown?: string | undefined
  readonly acceptanceCriteriaMarkdown?: string | undefined
  readonly reproStepsMarkdown?: string | undefined
  readonly parent?: {
    readonly id: number
    readonly title?: string | undefined
  }
  readonly related: ReadonlyArray<{
    readonly id: number
    readonly title?: string | undefined
  }>
  readonly recentComments: ReadonlyArray<{
    readonly author: string
    readonly createdAt: string
    readonly markdown: string
  }>
}

export const readAssignedToDisplayName = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  if (value && typeof value === "object" && "displayName" in value && typeof value.displayName === "string") {
    const trimmed = value.displayName.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  return undefined
}

export const WorkItemAssignedToFieldSchema = WorkItemAssignedToSchema
