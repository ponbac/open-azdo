import { Schema } from "effect"

export class PromptFileError extends Schema.TaggedError<PromptFileError>()("PromptFileError", {
  message: Schema.String,
  path: Schema.String,
}) {}

export class ReviewInputLimitError extends Schema.TaggedError<ReviewInputLimitError>()("ReviewInputLimitError", {
  message: Schema.String,
  actualBytes: Schema.Number,
  maximumBytes: Schema.Number,
}) {}

export class ReviewOutputValidationError extends Schema.TaggedError<ReviewOutputValidationError>()(
  "ReviewOutputValidationError",
  {
    message: Schema.String,
    issues: Schema.Array(Schema.String),
  },
) {}
