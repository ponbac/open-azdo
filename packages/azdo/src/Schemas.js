import { Schema } from "effect"
export const PullRequestMetadataResponseSchema = Schema.Struct({
  title: Schema.String,
  description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
})
const ExistingThreadStatusSchema = Schema.Union([
  Schema.Int,
  Schema.Literal("active"),
  Schema.Literal("fixed"),
  Schema.Literal("wontFix"),
  Schema.Literal("closed"),
  Schema.Literal("byDesign"),
  Schema.Literal("pending"),
])
const NullableIntSchema = Schema.Union([Schema.Int, Schema.Null])
export const ExistingThreadSchema = Schema.Struct({
  id: Schema.Int,
  status: Schema.optionalKey(Schema.Union([ExistingThreadStatusSchema, Schema.Null])),
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      content: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    }),
  ),
  threadContext: Schema.optionalKey(
    Schema.Union([
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
      Schema.Null,
    ]),
  ),
})
export const ExistingThreadsResponseSchema = Schema.Struct({
  value: Schema.optionalKey(Schema.Array(ExistingThreadSchema)),
})
