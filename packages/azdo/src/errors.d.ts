import { Schema } from "effect"
declare const AzureDevOpsHttpError_base: Schema.ErrorClass<
  AzureDevOpsHttpError,
  Schema.TaggedStruct<
    "AzureDevOpsHttpError",
    {
      readonly message: Schema.String
      readonly url: Schema.String
      readonly status: Schema.Number
      readonly body: Schema.String
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class AzureDevOpsHttpError extends AzureDevOpsHttpError_base {}
declare const AzureDevOpsDecodeError_base: Schema.ErrorClass<
  AzureDevOpsDecodeError,
  Schema.TaggedStruct<
    "AzureDevOpsDecodeError",
    {
      readonly message: Schema.String
      readonly url: Schema.String
      readonly body: Schema.String
      readonly issues: Schema.$Array<Schema.String>
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class AzureDevOpsDecodeError extends AzureDevOpsDecodeError_base {}
export {}
