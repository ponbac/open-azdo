import { Effect, Redacted } from "effect"
const REDACTED = "<redacted>"
const DEFAULT_PREVIEW_LENGTH = 400
const sanitizeKey = (key) => {
  const normalized = key.toLowerCase()
  return normalized.includes("token") || normalized.includes("secret") || normalized.includes("password")
}
export function sanitizeForLog(value) {
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
    const sanitizedEntries = []
    for (const [key, nested] of Object.entries(value)) {
      sanitizedEntries.push([key, sanitizeKey(key) ? REDACTED : sanitizeForLog(nested)])
    }
    return Object.fromEntries(sanitizedEntries)
  }
  return value
}
export const truncateForLog = (value, maxLength = DEFAULT_PREVIEW_LENGTH) => {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`
}
export const renderLogLine = (level, message, fields) =>
  JSON.stringify({
    level,
    message,
    ...sanitizeForLog(fields ?? {}),
  })
const withSanitizedAnnotations = (effect, fields) => {
  if (!fields || Object.keys(fields).length === 0) {
    return effect
  }
  return effect.pipe(Effect.annotateLogs(sanitizeForLog(fields)))
}
export const withLogAnnotations = (fields) => (effect) => withSanitizedAnnotations(effect, fields)
export const logInfo = (message, fields) => withSanitizedAnnotations(Effect.logInfo(message), fields)
export const logError = (message, fields) => withSanitizedAnnotations(Effect.logError(message), fields)
export const logDebug = (message, fields) => withSanitizedAnnotations(Effect.logDebug(message), fields)
