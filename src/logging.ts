import { Effect, Redacted } from "effect"

const REDACTED = "<redacted>"
const DEFAULT_PREVIEW_LENGTH = 400

type LogLevel = "info" | "error" | "debug"

export const sanitizeForLog = (value: unknown): unknown => {
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
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        key.toLowerCase().includes("token") || key.toLowerCase().includes("secret") ? REDACTED : sanitizeForLog(nested),
      ]),
    )
  }

  return value
}

export const truncateForLog = (value: string, maxLength = DEFAULT_PREVIEW_LENGTH) => {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`
}

export const renderLogLine = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
  const sanitizedFields = sanitizeForLog(fields ?? {}) as Record<string, unknown>
  return JSON.stringify({
    level,
    message,
    ...sanitizedFields,
  })
}

const withSanitizedAnnotations = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fields?: Record<string, unknown>,
): Effect.Effect<A, E, R> => {
  if (!fields || Object.keys(fields).length === 0) {
    return effect
  }

  return effect.pipe(Effect.annotateLogs(sanitizeForLog(fields) as Record<string, unknown>))
}

export const annotateLogsScoped = (fields?: Record<string, unknown>) => {
  if (!fields || Object.keys(fields).length === 0) {
    return Effect.void
  }

  return Effect.annotateLogsScoped(sanitizeForLog(fields) as Record<string, unknown>)
}

export const withLogAnnotations =
  (fields?: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    if (!fields || Object.keys(fields).length === 0) {
      return effect
    }

    return effect.pipe(Effect.annotateLogs(sanitizeForLog(fields) as Record<string, unknown>))
  }

export const logInfo = (message: string, fields?: Record<string, unknown>) =>
  withSanitizedAnnotations(Effect.logInfo(message), fields)

export const logError = (message: string, fields?: Record<string, unknown>) =>
  withSanitizedAnnotations(Effect.logError(message), fields)

export const logDebug = (message: string, fields?: Record<string, unknown>) =>
  withSanitizedAnnotations(Effect.logDebug(message), fields)
