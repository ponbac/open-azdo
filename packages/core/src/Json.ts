import { Effect } from "effect"

import { JsonParseError } from "./errors"

export const stringifyJson = (value: unknown) => JSON.stringify(value)

export const parseJsonUnknown = (value: string) =>
  Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: () =>
      new JsonParseError({
        message: "Failed to parse JSON input.",
        input: value,
      }),
  })
