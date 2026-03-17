import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { BaseRuntimeLayer } from "../src/app/Runtime"
import { buildReviewPrompt } from "../src/review/ReviewPrompt"
import type { ReviewContext } from "../src/review/ReviewContext"

const reviewContext: ReviewContext = {
  pullRequest: {
    title: "Feature PR",
    description: "Adds a new export",
  },
  baseRef: "abc123",
  headRef: "HEAD",
  changedFiles: [
    {
      path: "src/example.ts",
      changedLineRanges: [{ start: 2, end: 3 }],
      hunkHeaders: ["@@ -1 +1,2 @@"],
    },
  ],
}

describe("review prompt", () => {
  test("instructs the model to review files via an internal checklist and allowed commands", async () => {
    const prompt = await Effect.runPromise(
      buildReviewPrompt(undefined, reviewContext).pipe(Effect.provide(BaseRuntimeLayer)),
    )

    expect(prompt).toContain("Build an internal checklist containing every path in changedFiles")
    expect(prompt).toContain("For each changed file, inspect the diff with `git diff <baseRef> <headRef> -- <path>`")
    expect(prompt).toContain("Return strict JSON only with the shape:")
    expect(prompt).toContain("Keep the internal checklist private and do not include it in the final JSON output.")
    expect(prompt).toContain("Ground every finding in the review manifest plus repository evidence")
    expect(prompt).toContain("Use a lively review tone with emojis throughout the human-readable text fields.")
  })

  test("stays compact when the review manifest covers many changed lines", async () => {
    const lineRanges = Array.from({ length: 200 }, (_, index) => ({
      start: index * 5 + 1,
      end: index * 5 + 3,
    }))

    const prompt = await Effect.runPromise(
      buildReviewPrompt(undefined, {
        pullRequest: {
          title: "Large PR",
          description: "Touches a lot of lines",
        },
        baseRef: "base",
        headRef: "HEAD",
        changedFiles: [
          {
            path: "src/example.ts",
            changedLineRanges: lineRanges,
            hunkHeaders: ["@@ -1,3 +1,3 @@"],
          },
        ],
      } satisfies ReviewContext).pipe(Effect.provide(BaseRuntimeLayer)),
    )

    expect(prompt.length).toBeLessThan(15_000)
    expect(prompt).toContain('"changedLineRanges"')
    expect(prompt).not.toContain("diff --git")
  })

  test("fails explicitly when a prompt file cannot be read", async () => {
    const exit = await Effect.runPromiseExit(
      buildReviewPrompt("/definitely-missing/open-azdo-prompt.md", reviewContext).pipe(
        Effect.provide(BaseRuntimeLayer),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })
})
