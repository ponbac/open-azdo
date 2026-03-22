import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { normalizeWorkItemMarkdown, renderWorkItemMarkdown } from "../src/WorkItemMarkdown"

describe("work item markdown", () => {
  test("converts paragraphs and lists into readable markdown", async () => {
    const markdown = await Effect.runPromise(renderWorkItemMarkdown("<p>Hello</p><ul><li>One</li><li>Two</li></ul>"))

    expect(markdown).toContain("Hello")
    expect(markdown).toContain("-   One")
    expect(markdown).toContain("-   Two")
  })

  test("keeps anchor text and drops link urls", async () => {
    const markdown = await Effect.runPromise(
      renderWorkItemMarkdown('<p>See <a href="https://example.com/path">details</a></p>'),
    )

    expect(markdown).toContain("details")
    expect(markdown).not.toContain("https://example.com/path")
  })

  test("removes noisy media and normalizes whitespace", async () => {
    const markdown = await Effect.runPromise(
      renderWorkItemMarkdown('<p>Hello&nbsp;world</p><img src="x" /><div>\r\n\r\n</div><p>Next</p>'),
    )

    expect(markdown).toBe("Hello world\n\nNext")
  })

  test("returns undefined for empty input", async () => {
    const markdown = await Effect.runPromise(renderWorkItemMarkdown("   "))

    expect(markdown).toBeUndefined()
  })

  test("preserves plain markdown while normalizing whitespace", async () => {
    const markdown = await Effect.runPromise(normalizeWorkItemMarkdown("See **details**\r\n\r\n\r\n- one\r\n- two\r\n"))

    expect(markdown).toBe("See **details**\n\n- one\n- two")
  })

  test("preserves leading indentation in plain markdown", async () => {
    const markdown = await Effect.runPromise(normalizeWorkItemMarkdown("    bun test\r\n\r\n  nested"))

    expect(markdown).toBe("    bun test\n\n  nested")
  })

  test("returns undefined for empty plain markdown input", async () => {
    const markdown = await Effect.runPromise(normalizeWorkItemMarkdown("  \r\n "))

    expect(markdown).toBeUndefined()
  })
})
