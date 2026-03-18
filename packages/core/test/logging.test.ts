import { describe, expect, test } from "bun:test"
import { Redacted } from "effect"

import { renderLogLine, sanitizeForLog } from "@open-azdo/core/logging"

describe("logging", () => {
  test("redacts secrets in structured output", () => {
    const line = renderLogLine("info", "config", {
      systemAccessToken: Redacted.make("super-secret"),
      nested: {
        apiToken: "plain-secret",
      },
    })

    expect(line).not.toContain("super-secret")
    expect(line).not.toContain("plain-secret")
    expect(line).toContain("<redacted>")
  })

  test("sanitizes redacted values directly", () => {
    expect(sanitizeForLog(Redacted.make("secret"))).toBe("<redacted>")
  })
})
