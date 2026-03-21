import { Schema } from "effect"
declare const ConfigError_base: Schema.ErrorClass<
  ConfigError,
  Schema.TaggedStruct<
    "ConfigError",
    {
      readonly message: Schema.String
      readonly issues: Schema.$Array<Schema.String>
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class ConfigError extends ConfigError_base {}
declare const OperationalError_base: Schema.ErrorClass<
  OperationalError,
  Schema.TaggedStruct<
    "OperationalError",
    {
      readonly message: Schema.String
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class OperationalError extends OperationalError_base {}
export {}
