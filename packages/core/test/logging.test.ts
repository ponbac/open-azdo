import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger, Redacted } from "effect"
import * as TestConsole from "effect/testing/TestConsole"

import { JsonLoggerLayer, PrettyLoggerLayer, sanitizeForLog } from "@open-azdo/core/logging"

const collectConsoleLines = (jsonLogs: boolean, effect: Effect.Effect<unknown, never>) =>
  Effect.gen(function* () {
    yield* effect

    return {
      logLines: yield* TestConsole.logLines,
      errorLines: yield* TestConsole.errorLines,
    }
  }).pipe(
    Effect.provide(jsonLogs ? JsonLoggerLayer : PrettyLoggerLayer),
    Effect.provide(Layer.succeed(Logger.LogToStderr)(true)),
    Effect.provide(TestConsole.layer),
  )

describe("logging", () => {
  test("pretty mode renders redacted logs", async () => {
    const output = await Effect.runPromise(
      collectConsoleLines(
        false,
        Effect.logInfo("config").pipe(
          Effect.annotateLogs(
            sanitizeForLog({
              systemAccessToken: Redacted.make("super-secret"),
              nested: {
                apiToken: "plain-secret",
              },
            }),
          ),
        ),
      ),
    )

    const rendered = [...output.errorLines, ...output.logLines].join("\n")

    expect(rendered).toContain("config")
    expect(rendered).toContain("<redacted>")
    expect(rendered).not.toContain("super-secret")
    expect(rendered).not.toContain("plain-secret")
  })

  test("json mode writes redacted logs to stderr", async () => {
    const output = await Effect.runPromise(
      collectConsoleLines(
        true,
        Effect.logInfo("git").pipe(
          Effect.annotateLogs(
            sanitizeForLog({
              command:
                "git fetch https://user:very-secret@example.com/repo.git Authorization: Bearer super-secret OPEN_AZDO_LIVE_ACCESS_TOKEN=super-secret",
              error: new Error("Authorization: Bearer error-secret"),
            }),
          ),
        ),
      ),
    )

    expect(output.errorLines).toHaveLength(1)
    expect(output.errorLines[0]).toContain('"message":"git"')
    expect(output.errorLines[0]).toContain("<redacted>")
    expect(output.errorLines[0]).not.toContain("very-secret")
    expect(output.errorLines[0]).not.toContain("super-secret")
    expect(output.errorLines[0]).not.toContain("error-secret")
  })

  test("sanitizes redacted values directly", () => {
    expect(sanitizeForLog(Redacted.make("secret"))).toBe("<redacted>")
  })

  test("preserves reserved field names as own log data", () => {
    const sanitized = sanitizeForLog({ ["__proto__"]: { value: "kept" }, constructor: "ok" })

    expect(JSON.stringify(sanitized)).toBe('{"__proto__":{"value":"kept"},"constructor":"ok"}')
    expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype)
  })
})
