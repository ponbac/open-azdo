import { Schema } from "effect"
export class PromptFileError extends Schema.TaggedErrorClass()("PromptFileError", {
  message: Schema.String,
  path: Schema.String,
}) {}
export class ReviewOutputValidationError extends Schema.TaggedErrorClass()("ReviewOutputValidationError", {
  message: Schema.String,
  issues: Schema.Array(Schema.String),
}) {}
