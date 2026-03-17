import { Schema } from "effect"

export const PullRequestMetadataSchema = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
  url: Schema.optionalKey(Schema.String),
})
export type PullRequestMetadata = Schema.Schema.Type<typeof PullRequestMetadataSchema>

export const ExistingThreadSchema = Schema.Struct({
  id: Schema.Int,
  status: Schema.Int,
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      content: Schema.optionalKey(Schema.String),
    }),
  ),
  threadContext: Schema.optionalKey(
    Schema.Struct({
      filePath: Schema.optionalKey(Schema.String),
      rightFileStart: Schema.optionalKey(
        Schema.Struct({
          line: Schema.optionalKey(Schema.Int),
          offset: Schema.optionalKey(Schema.Int),
        }),
      ),
      rightFileEnd: Schema.optionalKey(
        Schema.Struct({
          line: Schema.optionalKey(Schema.Int),
          offset: Schema.optionalKey(Schema.Int),
        }),
      ),
    }),
  ),
})
export type ExistingThread = Schema.Schema.Type<typeof ExistingThreadSchema>

export const ExistingThreadsResponseSchema = Schema.Struct({
  value: Schema.Array(ExistingThreadSchema),
})
export type ExistingThreadsResponse = Schema.Schema.Type<typeof ExistingThreadsResponseSchema>
