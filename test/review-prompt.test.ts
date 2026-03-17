import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"

import { buildReviewPrompt } from "../src/review-prompt"
import { makeReviewConfig } from "./helpers"

describe("review prompt", () => {
  test("instructs the model to review files via an internal checklist and allowed commands", async () => {
    const prompt = await Effect.runPromise(
      buildReviewPrompt(makeReviewConfig(), {
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
      }).pipe(Effect.provide(BunServices.layer)),
    )

    expect(prompt).toContain("Build an internal checklist containing every path in changedFiles")
    expect(prompt).toContain("For each changed file, inspect the diff with `git diff <baseRef> <headRef> -- <path>`")
    expect(prompt).toContain("Return strict JSON only with the shape:")
    expect(prompt).toContain("Keep the internal checklist private and do not include it in the final JSON output.")
    expect(prompt).not.toContain("Only report issues grounded in the provided diff and file excerpts.")
    expect(prompt).toContain("Use a lively review tone with emojis throughout the human-readable text fields.")
    expect(prompt).toContain(
      "Include emojis in summary, finding titles, finding bodies, and unmapped notes; prefer multiple relevant emojis instead of a single token.",
    )
  })

  test("stays compact when the review manifest covers many changed lines", async () => {
    const lineRanges = Array.from({ length: 200 }, (_, index) => ({
      start: index * 5 + 1,
      end: index * 5 + 3,
    }))

    const prompt = await Effect.runPromise(
      buildReviewPrompt(makeReviewConfig(), {
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
      }).pipe(Effect.provide(BunServices.layer)),
    )

    expect(prompt.length).toBeLessThan(15_000)
    expect(prompt).toContain('"changedLineRanges"')
    expect(prompt).not.toContain("diff --git")
  })
})
