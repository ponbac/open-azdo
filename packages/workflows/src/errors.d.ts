import { Schema } from "effect"
declare const PromptFileError_base: Schema.ErrorClass<
  PromptFileError,
  Schema.TaggedStruct<
    "PromptFileError",
    {
      readonly message: Schema.String
      readonly path: Schema.String
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class PromptFileError extends PromptFileError_base {}
declare const ReviewOutputValidationError_base: Schema.ErrorClass<
  ReviewOutputValidationError,
  Schema.TaggedStruct<
    "ReviewOutputValidationError",
    {
      readonly message: Schema.String
      readonly issues: Schema.$Array<Schema.String>
    }
  >,
  import("effect/Cause").YieldableError
>
export declare class ReviewOutputValidationError extends ReviewOutputValidationError_base {}
export {}
