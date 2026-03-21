import { Effect } from "effect"
import { JsonParseError } from "./errors"
export declare const stringifyJson: (value: unknown) => string
export declare const parseJsonUnknown: (value: string) => Effect.Effect<unknown, JsonParseError, never>
