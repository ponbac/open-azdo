import { Schema } from "effect"
export class ConfigError extends Schema.TaggedErrorClass()("ConfigError", {
  message: Schema.String,
  issues: Schema.Array(Schema.String),
}) {}
export class OperationalError extends Schema.TaggedErrorClass()("OperationalError", {
  message: Schema.String,
}) {}
