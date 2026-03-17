import { Redacted } from "effect"

const REDACTED = "<redacted>"

type LogLevel = "info" | "error"

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

export const renderLogLine = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
  const sanitizedFields = sanitizeForLog(fields ?? {}) as Record<string, unknown>
  return JSON.stringify({
    level,
    message,
    ...sanitizedFields,
  })
}

export const writeInfoLog = (message: string, fields?: Record<string, unknown>) => {
  process.stdout.write(`${renderLogLine("info", message, fields)}\n`)
}

export const writeErrorLog = (message: string, fields?: Record<string, unknown>) => {
  process.stderr.write(`${renderLogLine("error", message, fields)}\n`)
}
