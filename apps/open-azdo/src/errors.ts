import { Schema } from "effect"

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String,
  issues: Schema.Array(Schema.String),
}) {}

export class OperationalError extends Schema.TaggedErrorClass<OperationalError>()("OperationalError", {
  message: Schema.String,
}) {}
