import { Schema } from "effect"

const JsonStringSchema = Schema.UnknownFromJsonString

export const parseJsonString = <T = unknown>(value: string) => Schema.decodeUnknownSync(JsonStringSchema)(value) as T

export const stringifyJson = (value: unknown) => Schema.encodeUnknownSync(JsonStringSchema)(value)
