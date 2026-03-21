import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BaseRuntimeLayer } from "@open-azdo/core/base-runtime"
import { buildReviewPrompt } from "../src/review/ReviewPrompt"
import { withSilentLogs } from "./helpers"
const reviewContext = {
  pullRequest: {
    title: "Feature PR",
    description: "Adds a new export",
  },
  reviewMode: "full",
  pullRequestBaseRef: "abc123",
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
      buildReviewPrompt(undefined, reviewContext).pipe(Effect.provide(BaseRuntimeLayer), withSilentLogs),
    )
    expect(prompt).toContain("Build an internal checklist containing every path in scoped changedFiles")
    expect(prompt).toContain(
      "For each scoped changed file, inspect the diff with `git diff <baseRef> <headRef> -- <path>`",
    )
    expect(prompt).toContain("Return strict JSON only with the shape:")
    expect(prompt).toContain("Keep the internal checklist private and do not include it in the final JSON output.")
    expect(prompt).toContain("Ground every finding in the review manifest plus repository evidence")
    expect(prompt).toContain("Use a lively review tone with emojis throughout the human-readable text fields.")
    expect(prompt).toContain("Markdown Style For Review Comments:")
    expect(prompt).toContain("Skip snapshot files")
  })
  test("adds follow-up instructions when reviewing changes since the last managed review", async () => {
    const prompt = await Effect.runPromise(
      buildReviewPrompt(undefined, {
        ...reviewContext,
        reviewMode: "follow-up",
        previousReviewedCommit: "prev123",
        baseRef: "prev123",
        headRef: "next456",
      }).pipe(Effect.provide(BaseRuntimeLayer), withSilentLogs),
    )
    expect(prompt).toContain("This is a follow-up review.")
    expect(prompt).toContain("do not revisit untouched pull-request areas")
    expect(prompt).toContain("do not re-litigate older findings")
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
        reviewMode: "full",
        pullRequestBaseRef: "base",
        baseRef: "base",
        headRef: "HEAD",
        changedFiles: [
          {
            path: "src/example.ts",
            changedLineRanges: lineRanges,
            hunkHeaders: ["@@ -1,3 +1,3 @@"],
          },
        ],
      }).pipe(Effect.provide(BaseRuntimeLayer), withSilentLogs),
    )
    expect(prompt.length).toBeLessThan(15_000)
    expect(prompt).toContain('"changedLineRanges"')
    expect(prompt).not.toContain("diff --git")
  })
  test("fails explicitly when a prompt file cannot be read", async () => {
    const exit = await Effect.runPromiseExit(
      buildReviewPrompt("/definitely-missing/open-azdo-prompt.md", reviewContext).pipe(
        Effect.provide(BaseRuntimeLayer),
        withSilentLogs,
      ),
    )
    expect(exit._tag).toBe("Failure")
  })
})
