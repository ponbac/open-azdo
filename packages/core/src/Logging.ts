import { Effect, Redacted } from "effect"

const REDACTED = "<redacted>"
const DEFAULT_PREVIEW_LENGTH = 400

const sanitizeKey = (key: string) => {
  const normalized = key.toLowerCase()
  return normalized.includes("token") || normalized.includes("secret") || normalized.includes("password")
}

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

  return value
}

export const truncateForLog = (value: string, maxLength = DEFAULT_PREVIEW_LENGTH) => {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`
}

export const renderLogLine = (level: "info" | "error" | "debug", message: string, fields?: Record<string, unknown>) =>
  JSON.stringify({
    level,
    message,
    ...sanitizeForLog(fields ?? {}),
  })

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

export const logDebug = (message: string, fields?: Record<string, unknown>) =>
  withSanitizedAnnotations(Effect.logDebug(message), fields)
