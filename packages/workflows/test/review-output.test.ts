import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { decodeReviewResult } from "../src/review/ReviewOutput"

describe("review output", () => {
  test("rejects invalid severities", async () => {
    const exit = await Effect.runPromiseExit(
      decodeReviewResult(
        {
          verdict: "concerns",
          findings: [
            {
              severity: "urgent",
              confidence: "high",
              title: "Bad",
              body: "Bad",
              filePath: "src/example.ts",
              line: 2,
            },
          ],
          unmappedNotes: [],
        },
        new Map([["src/example.ts", new Set([2])]]),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("keeps low-confidence findings in the summary only", async () => {
    const result = await Effect.runPromise(
      decodeReviewResult(
        {
          verdict: "concerns",
          findings: [
            {
              severity: "medium",
              confidence: "low",
              title: "Low confidence",
              body: "Body",
              filePath: "src/example.ts",
              line: 2,
            },
          ],
          unmappedNotes: [],
        },
        new Map([["src/example.ts", new Set([2])]]),
      ),
    )

    expect(result.inlineFindings).toHaveLength(0)
    expect(result.summaryOnlyFindings).toHaveLength(1)
  })

  test("moves unmapped findings to summary-only notes", async () => {
    const result = await Effect.runPromise(
      decodeReviewResult(
        {
          verdict: "concerns",
          findings: [
            {
              severity: "high",
              confidence: "high",
              title: "Unmapped",
              body: "Body",
              filePath: "src/example.ts",
              line: 99,
            },
          ],
          unmappedNotes: [],
        },
        new Map([["src/example.ts", new Set([2])]]),
      ),
    )

    expect(result.inlineFindings).toHaveLength(0)
    expect(result.unmappedNotes[0]).toContain("Unmapped")
  })

  test("keeps follow-up findings outside the scoped diff out of inline comments", async () => {
    const result = await Effect.runPromise(
      decodeReviewResult(
        {
          verdict: "concerns",
          findings: [
            {
              severity: "high",
              confidence: "high",
              title: "Old line",
              body: "Body",
              filePath: "src/example.ts",
              line: 2,
            },
          ],
          unmappedNotes: [],
        },
        new Map([["src/example.ts", new Set([10])]]),
      ),
    )

    expect(result.inlineFindings).toHaveLength(0)
    expect(result.summaryOnlyFindings).toHaveLength(1)
    expect(result.unmappedNotes[0]).toContain("Old line")
  })

  test("trims and drops blank unmapped notes during normalization", async () => {
    const result = await Effect.runPromise(
      decodeReviewResult(
        {
          verdict: "concerns",
          findings: [],
          unmappedNotes: ["  Needs follow-up  ", " ", ""],
        },
        new Map(),
      ),
    )

    expect(result.unmappedNotes).toEqual(["Needs follow-up"])
  })
})
