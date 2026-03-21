import { Schema } from "effect"
export declare const PullRequestMetadataResponseSchema: Schema.Struct<{
  readonly title: Schema.String
  readonly description: Schema.optionalKey<Schema.Union<readonly [Schema.String, Schema.Null]>>
  readonly url: Schema.optionalKey<Schema.Union<readonly [Schema.String, Schema.Null]>>
}>
export type PullRequestMetadata = {
  readonly title: string
  readonly description: string
  readonly url?: string | undefined
}
export declare const ExistingThreadSchema: Schema.Struct<{
  readonly id: Schema.Int
  readonly status: Schema.optionalKey<
    Schema.Union<
      readonly [
        Schema.Union<
          readonly [
            Schema.Int,
            Schema.Literal<"active">,
            Schema.Literal<"fixed">,
            Schema.Literal<"wontFix">,
            Schema.Literal<"closed">,
            Schema.Literal<"byDesign">,
            Schema.Literal<"pending">,
          ]
        >,
        Schema.Null,
      ]
    >
  >
  readonly comments: Schema.$Array<
    Schema.Struct<{
      readonly id: Schema.Int
      readonly content: Schema.optionalKey<Schema.Union<readonly [Schema.String, Schema.Null]>>
    }>
  >
  readonly threadContext: Schema.optionalKey<
    Schema.Union<
      readonly [
        Schema.Struct<{
          readonly filePath: Schema.optionalKey<Schema.String>
          readonly rightFileStart: Schema.optionalKey<
            Schema.Struct<{
              readonly line: Schema.optionalKey<Schema.Union<readonly [Schema.Int, Schema.Null]>>
              readonly offset: Schema.optionalKey<Schema.Union<readonly [Schema.Int, Schema.Null]>>
            }>
          >
          readonly rightFileEnd: Schema.optionalKey<
            Schema.Struct<{
              readonly line: Schema.optionalKey<Schema.Union<readonly [Schema.Int, Schema.Null]>>
              readonly offset: Schema.optionalKey<Schema.Union<readonly [Schema.Int, Schema.Null]>>
            }>
          >
        }>,
        Schema.Null,
      ]
    >
  >
}>
export type ExistingThread = Schema.Schema.Type<typeof ExistingThreadSchema>
export declare const ExistingThreadsResponseSchema: Schema.Struct<{
  readonly value: Schema.optionalKey<
    Schema.$Array<
      Schema.Struct<{
        readonly id: Schema.Int
        readonly status: Schema.optionalKey<
          Schema.Union<
            readonly [
              Schema.Union<
                readonly [
                  Schema.Int,
                  Schema.Literal<"active">,
                  Schema.Literal<"fixed">,
                  Schema.Literal<"wontFix">,
                  Schema.Literal<"closed">,
                  Schema.Literal<"byDesign">,
                  Schema.Literal<"pending">,
                ]
              >,
              Schema.Null,
            ]
          >
        >
        readonly comments: Schema.$Array<
          Schema.Struct<{
            readonly id: Schema.Int
            readonly content: Schema.optionalKey<Schema.Union<readonly [Schema.String, Schema.Null]>>
          }>
        >
        readonly threadContext: Schema.optionalKey<
          Schema.Union<
            readonly [
              Schema.Struct<{
                readonly filePath: Schema.optionalKey<Schema.String>
                readonly rightFileStart: Schema.optionalKey<
                  Schema.Struct<{
                    readonly line: Schema.optionalKey<Schema.Union<readonly [Schema.Int, Schema.Null]>>
                    readonly offset: Schema.optionalKey<Schema.Union<readonly [Schema.Int, Schema.Null]>>
                  }>
                >
                readonly rightFileEnd: Schema.optionalKey<
                  Schema.Struct<{
                    readonly line: Schema.optionalKey<Schema.Union<readonly [Schema.Int, Schema.Null]>>
                    readonly offset: Schema.optionalKey<Schema.Union<readonly [Schema.Int, Schema.Null]>>
                  }>
                >
              }>,
              Schema.Null,
            ]
          >
        >
      }>
    >
  >
}>
export type ExistingThreadsResponse = Schema.Schema.Type<typeof ExistingThreadsResponseSchema>
