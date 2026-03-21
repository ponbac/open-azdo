import { Schema } from "effect"
declare const CommandExecutionError_base: Schema.ErrorClass<
  CommandExecutionError,
  Schema.TaggedStruct<
    "CommandExecutionError",
    {
      readonly operation: Schema.String
      readonly command: Schema.$Array<Schema.String>
      readonly cwd: Schema.String
      readonly detail: Schema.String
      readonly stderr: Schema.String
      readonly exitCode: Schema.Number
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class CommandExecutionError extends CommandExecutionError_base {}
declare const GitCommandError_base: Schema.ErrorClass<
  GitCommandError,
  Schema.TaggedStruct<
    "GitCommandError",
    {
      readonly operation: Schema.String
      readonly command: Schema.String
      readonly cwd: Schema.String
      readonly detail: Schema.String
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class GitCommandError extends GitCommandError_base {}
declare const MissingGitHistoryError_base: Schema.ErrorClass<
  MissingGitHistoryError,
  Schema.TaggedStruct<
    "MissingGitHistoryError",
    {
      readonly message: Schema.String
      readonly remediation: Schema.String
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class MissingGitHistoryError extends MissingGitHistoryError_base {}
declare const JsonParseError_base: Schema.ErrorClass<
  JsonParseError,
  Schema.TaggedStruct<
    "JsonParseError",
    {
      readonly message: Schema.String
      readonly input: Schema.String
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class JsonParseError extends JsonParseError_base {}
declare const OpenCodeInvocationError_base: Schema.ErrorClass<
  OpenCodeInvocationError,
  Schema.TaggedStruct<
    "OpenCodeInvocationError",
    {
      readonly message: Schema.String
      readonly stderr: Schema.String
      readonly exitCode: Schema.Number
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class OpenCodeInvocationError extends OpenCodeInvocationError_base {}
declare const OpenCodeOutputError_base: Schema.ErrorClass<
  OpenCodeOutputError,
  Schema.TaggedStruct<
    "OpenCodeOutputError",
    {
      readonly message: Schema.String
      readonly output: Schema.String
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class OpenCodeOutputError extends OpenCodeOutputError_base {}
export {}
