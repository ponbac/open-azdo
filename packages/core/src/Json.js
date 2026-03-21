import { Effect } from "effect"
import { JsonParseError } from "./errors"
export const stringifyJson = (value) => JSON.stringify(value)
export const parseJsonUnknown = (value) =>
  Effect.try({
    try: () => JSON.parse(value),
    catch: () =>
      new JsonParseError({
        message: "Failed to parse JSON input.",
        input: value,
      }),
  })
