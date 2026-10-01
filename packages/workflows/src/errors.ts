import { Schema } from "effect"

export class PromptFileError extends Schema.TaggedError<PromptFileError>()("PromptFileError", {
  message: Schema.String,
  path: Schema.String,
}) {}

export class ReviewOutputValidationError extends Schema.TaggedError<ReviewOutputValidationError>()(
  "ReviewOutputValidationError",
  {
    message: Schema.String,
    issues: Schema.Array(Schema.String),
  },
) {}
