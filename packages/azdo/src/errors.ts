import { Schema } from "effect"

export class AzureDevOpsHttpError extends Schema.TaggedError<AzureDevOpsHttpError>()("AzureDevOpsHttpError", {
  message: Schema.String,
  url: Schema.String,
  status: Schema.Number,
  body: Schema.String,
}) {}

export class AzureDevOpsDecodeError extends Schema.TaggedError<AzureDevOpsDecodeError>()("AzureDevOpsDecodeError", {
  message: Schema.String,
  url: Schema.String,
  body: Schema.String,
  issues: Schema.Array(Schema.String),
}) {}
