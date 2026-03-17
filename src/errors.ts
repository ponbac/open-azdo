import { Schema } from "effect"

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String,
  issues: Schema.Array(Schema.String),
}) {}

export class CommandExecutionError extends Schema.TaggedErrorClass<CommandExecutionError>()("CommandExecutionError", {
  operation: Schema.String,
  command: Schema.Array(Schema.String),
  cwd: Schema.String,
  detail: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
}) {}

export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
}) {}

export class MissingGitHistoryError extends Schema.TaggedErrorClass<MissingGitHistoryError>()(
  "MissingGitHistoryError",
  {
    message: Schema.String,
    remediation: Schema.String,
  },
) {}

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

export class JsonParseError extends Schema.TaggedErrorClass<JsonParseError>()("JsonParseError", {
  message: Schema.String,
  input: Schema.String,
}) {}

export class OpenCodeInvocationError extends Schema.TaggedErrorClass<OpenCodeInvocationError>()(
  "OpenCodeInvocationError",
  {
    message: Schema.String,
    stderr: Schema.String,
    exitCode: Schema.Number,
  },
) {}

export class OpenCodeOutputError extends Schema.TaggedErrorClass<OpenCodeOutputError>()("OpenCodeOutputError", {
  message: Schema.String,
  output: Schema.String,
}) {}

export class PromptFileError extends Schema.TaggedErrorClass<PromptFileError>()("PromptFileError", {
  message: Schema.String,
  path: Schema.String,
}) {}

export class ReviewOutputValidationError extends Schema.TaggedErrorClass<ReviewOutputValidationError>()(
  "ReviewOutputValidationError",
  {
    message: Schema.String,
    issues: Schema.Array(Schema.String),
  },
) {}

export class OperationalError extends Schema.TaggedErrorClass<OperationalError>()("OperationalError", {
  message: Schema.String,
}) {}
