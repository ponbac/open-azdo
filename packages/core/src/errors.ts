import { Schema } from "effect"

export class CommandExecutionError extends Schema.TaggedError<CommandExecutionError>()("CommandExecutionError", {
  operation: Schema.String,
  command: Schema.Array(Schema.String),
  cwd: Schema.String,
  detail: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
}) {}

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
}) {}

export class MissingGitHistoryError extends Schema.TaggedError<MissingGitHistoryError>()("MissingGitHistoryError", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

export class JsonParseError extends Schema.TaggedError<JsonParseError>()("JsonParseError", {
  message: Schema.String,
  input: Schema.String,
}) {}

export class OpenCodeInvocationError extends Schema.TaggedError<OpenCodeInvocationError>()("OpenCodeInvocationError", {
  message: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
}) {}

export class OpenCodeOutputError extends Schema.TaggedError<OpenCodeOutputError>()("OpenCodeOutputError", {
  message: Schema.String,
  output: Schema.String,
}) {}
