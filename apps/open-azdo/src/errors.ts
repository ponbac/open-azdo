import { Schema } from "effect"

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  issues: Schema.Array(Schema.String),
}) {}

export class OperationalError extends Schema.TaggedError<OperationalError>()("OperationalError", {
  message: Schema.String,
}) {}
