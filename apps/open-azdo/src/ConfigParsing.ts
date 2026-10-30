import { Effect, Schema } from "effect"
import * as Duration from "effect/Duration"

import { ConfigError } from "./errors"

const DEFAULT_OPENCODE_TIMEOUT = Duration.minutes(10)
const BARE_DURATION_REGEXP = /^-?\d+(?:\.\d+)?$/

const invalidOpenCodeTimeout = (value: string, issue: string) =>
  new ConfigError({
    message: "Invalid OpenCode timeout.",
    issues: [`${issue} Received ${JSON.stringify(value)}.`, 'Use values like "300 seconds" or "5 minutes".'],
  })

/** Parse the shared finite, positive timeout policy, defaulting only when absent. */
export const resolveOpenCodeTimeout = Effect.fn("ConfigParsing.resolveOpenCodeTimeout")(function* (
  value: string | undefined,
) {
  if (value === undefined) {
    return DEFAULT_OPENCODE_TIMEOUT
  }

  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return yield* invalidOpenCodeTimeout(value, "Timeout cannot be empty.")
  }

  if (BARE_DURATION_REGEXP.test(trimmed)) {
    return yield* invalidOpenCodeTimeout(value, "Timeout must include an explicit unit.")
  }

  const duration = yield* Schema.decodeUnknownEffect(Schema.DurationFromString)(trimmed).pipe(
    Effect.mapError(() =>
      invalidOpenCodeTimeout(value, "Timeout must use Effect duration syntax with an explicit unit."),
    ),
  )

  if (!Duration.isFinite(duration)) {
    return yield* invalidOpenCodeTimeout(value, "Timeout must be finite.")
  }

  if (!Duration.isPositive(duration)) {
    return yield* invalidOpenCodeTimeout(value, "Timeout must be greater than zero.")
  }

  return duration
})

/** Reject malformed collection URLs and protocols unsupported by the Azure HTTP client. */
export const validateCollectionUrl = (collectionUrl: string) =>
  Effect.try({
    try: () => {
      const url = new URL(collectionUrl)

      if (!/^https?:$/.test(url.protocol)) {
        throw new Error("Collection URL must use http or https.")
      }
    },
    catch: (error) =>
      new ConfigError({
        message: "Invalid Azure DevOps collection URL.",
        issues: [String(error)],
      }),
  })
