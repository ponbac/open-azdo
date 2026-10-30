import { Array as EffectArray, Effect, Layer, Predicate, Redacted, type Schema } from "effect"
import * as Logger from "effect/Logger"

const REDACTED = "<redacted>"
const DEFAULT_PREVIEW_LENGTH = 400

const SECRET_STRING_PATTERNS = [
  /authorization:\s*(?:basic|bearer)\s+[^\s"']+/gi,
  /https?:\/\/[^/\s:@]+:[^@\s]+@/gi,
  /open_azdo_live_access_token=[^\s"']+/gi,
] as const

const sanitizeKey = (key: string) => {
  const normalized = key.toLowerCase()

  return normalized.includes("token") || normalized.includes("secret") || normalized.includes("password")
}

const sanitizeString = (value: string) =>
  SECRET_STRING_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED), value)

/** Values supported by structured operational logs; arbitrary SDK/runtime objects must be projected first. */
export type LogValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Error
  | Redacted.Redacted<string>
  | ReadonlyArray<LogValue>
  | LogFields

/** Named operational fields, recursively restricted to printable values with explicit error/redaction support. */
export interface LogFields {
  readonly [key: string]: LogValue
}

/** Redacts supported log values into JSON, omitting absent object fields and preserving array positions. */
export function sanitizeForLog(value: LogFields): Schema.JsonObject
export function sanitizeForLog(value: ReadonlyArray<LogValue>): Schema.JsonArray
export function sanitizeForLog(value: LogValue): Schema.Json | undefined
export function sanitizeForLog(value: LogValue): Schema.Json | undefined {
  if (Redacted.isRedacted(value)) {
    return REDACTED
  }

  if (value instanceof Error) {
    return {
      name: sanitizeString(value.name),
      message: sanitizeString(value.message),
    }
  }

  if (EffectArray.isArray<LogValue>(value)) {
    return value.map((nested) => sanitizeForLog(nested) ?? null)
  }

  if (Predicate.isString(value)) {
    return sanitizeString(value)
  }

  if (Predicate.isBigInt(value)) {
    return String(value)
  }

  if (value === null || value === undefined || Predicate.isBoolean(value) || Predicate.isNumber(value)) {
    return value
  }

  const sanitized: Array<[string, Schema.Json]> = []

  for (const [key, nested] of Object.entries(value)) {
    const next = sanitizeKey(key) ? REDACTED : sanitizeForLog(nested)

    if (next !== undefined) {
      sanitized.push([key, next])
    }
  }

  // Preserve reserved names such as __proto__ as data instead of invoking object setters.
  return Object.fromEntries(sanitized)
}

/** Bounds diagnostic previews while retaining the omitted character count. */
export const truncateForLog = (value: string, maxLength = DEFAULT_PREVIEW_LENGTH) => {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`
}

/** Emits colorized human-readable operational logs on stderr, leaving stdout for command results. */
export const PrettyLoggerLayer = Logger.layer([Logger.consolePretty({ colors: true, mode: "tty" })]).pipe(
  Layer.provideMerge(Layer.succeed(Logger.LogToStderr)(true)),
)

/** Emits structured JSON operational logs on stderr, leaving stdout for command results. */
export const JsonLoggerLayer = Logger.layer([Logger.withConsoleError(Logger.formatJson)]).pipe(
  Layer.provideMerge(Layer.succeed(Logger.LogToStderr)(true)),
)

const withSanitizedAnnotations = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fields?: LogFields,
): Effect.Effect<A, E, R> => {
  if (!fields || Object.keys(fields).length === 0) {
    return effect
  }

  return effect.pipe(Effect.annotateLogs(sanitizeForLog(fields)))
}

/** Attach safe, recursively redacted operational fields to an effect's log context. */
export const withLogAnnotations =
  (fields?: LogFields) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    withSanitizedAnnotations(effect, fields)

/** Emit an informational message with safe operational fields. */
export const logInfo = (message: string, fields?: LogFields) =>
  withSanitizedAnnotations(Effect.logInfo(message), fields)

/** Emit an error message with safe operational fields. */
export const logError = (message: string, fields?: LogFields) =>
  withSanitizedAnnotations(Effect.logError(message), fields)

/** Emit a warning message with safe operational fields. */
export const logWarning = (message: string, fields?: LogFields) =>
  withSanitizedAnnotations(Effect.logWarning(message), fields)

/** Emit a debug message with safe operational fields. */
export const logDebug = (message: string, fields?: LogFields) =>
  withSanitizedAnnotations(Effect.logDebug(message), fields)
