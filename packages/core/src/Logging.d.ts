import { Effect } from "effect"
export declare function sanitizeForLog(value: Record<string, unknown>): Record<string, unknown>
export declare function sanitizeForLog(value: ReadonlyArray<unknown>): ReadonlyArray<unknown>
export declare function sanitizeForLog(value: unknown): unknown
export declare const truncateForLog: (value: string, maxLength?: number) => string
export declare const renderLogLine: (
  level: "info" | "error" | "debug",
  message: string,
  fields?: Record<string, unknown>,
) => string
export declare const withLogAnnotations: (
  fields?: Record<string, unknown>,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
export declare const logInfo: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void, never, never>
export declare const logError: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void, never, never>
export declare const logDebug: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void, never, never>
