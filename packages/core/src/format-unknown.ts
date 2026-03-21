import { stringifyJson } from "./Json"

export const formatUnknownDetail = (value: unknown): string => {
  if (typeof value === "string") {
    return value
  }

  if (value instanceof Error) {
    return value.message
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }

  if (value === undefined) {
    return "undefined"
  }

  if (value === null) {
    return "null"
  }

  return stringifyJson(value)
}
