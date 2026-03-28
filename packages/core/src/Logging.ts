import { Effect, Redacted } from "effect"
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

export function sanitizeForLog(value: Record<string, unknown>): Record<string, unknown>
export function sanitizeForLog(value: ReadonlyArray<unknown>): ReadonlyArray<unknown>
export function sanitizeForLog(value: unknown): unknown
export function sanitizeForLog(value: unknown): unknown {
  if (Redacted.isRedacted(value)) {
    return REDACTED
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    }
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeForLog)
  }

  if (value && typeof value === "object") {
    const sanitizedEntries: [string, unknown][] = []

    for (const [key, nested] of Object.entries(value)) {
      sanitizedEntries.push([key, sanitizeKey(key) ? REDACTED : sanitizeForLog(nested)])
    }

    return Object.fromEntries(sanitizedEntries)
  }

  if (typeof value === "string") {
    return sanitizeString(value)
  }

  return value
}

export const truncateForLog = (value: string, maxLength = DEFAULT_PREVIEW_LENGTH) => {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`
}

/**
 * Selects the runtime logger for human or machine-oriented execution.
 *
 * Pretty mode always writes colorized output to stderr so command results can
 * keep stdout clean. JSON mode preserves the same stderr contract while
 * emitting structured log events for automation.
 */
export const makeRuntimeLogger = (jsonLogs: boolean) =>
  jsonLogs ? Logger.withConsoleError(Logger.formatJson) : Logger.consolePretty({ colors: true, mode: "tty" })

const withSanitizedAnnotations = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fields?: Record<string, unknown>,
): Effect.Effect<A, E, R> => {
  if (!fields || Object.keys(fields).length === 0) {
    return effect
  }

  return effect.pipe(Effect.annotateLogs(sanitizeForLog(fields)))
}

export const withLogAnnotations =
  (fields?: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    withSanitizedAnnotations(effect, fields)

export const logInfo = (message: string, fields?: Record<string, unknown>) =>
  withSanitizedAnnotations(Effect.logInfo(message), fields)

export const logError = (message: string, fields?: Record<string, unknown>) =>
  withSanitizedAnnotations(Effect.logError(message), fields)

export const logWarning = (message: string, fields?: Record<string, unknown>) =>
  withSanitizedAnnotations(Effect.logWarning(message), fields)

export const logDebug = (message: string, fields?: Record<string, unknown>) =>
  withSanitizedAnnotations(Effect.logDebug(message), fields)
