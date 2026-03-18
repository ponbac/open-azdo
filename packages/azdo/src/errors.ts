import { Schema } from "effect"

export class AzureDevOpsHttpError extends Schema.TaggedErrorClass<AzureDevOpsHttpError>()("AzureDevOpsHttpError", {
  message: Schema.String,
  url: Schema.String,
  status: Schema.Number,
  body: Schema.String,
}) {}

export class AzureDevOpsDecodeError extends Schema.TaggedErrorClass<AzureDevOpsDecodeError>()(
  "AzureDevOpsDecodeError",
  {
    message: Schema.String,
    url: Schema.String,
    body: Schema.String,
    issues: Schema.Array(Schema.String),
  },
) {}
