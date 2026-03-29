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
          resolvedManagedFindingIds: [],
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
          resolvedManagedFindingIds: [],
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
          resolvedManagedFindingIds: [],
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
          resolvedManagedFindingIds: [],
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
          resolvedManagedFindingIds: [],
          unmappedNotes: ["  Needs follow-up  ", " ", ""],
        },
        new Map(),
      ),
    )

    expect(result.unmappedNotes).toEqual(["Needs follow-up"])
  })

  test("drops unknown, duplicate, and conflicting reconciliation ids conservatively", async () => {
    const result = await Effect.runPromise(
      decodeReviewResult(
        {
          verdict: "concerns",
          findings: [
            {
              severity: "high",
              confidence: "high",
              title: "Linked finding",
              body: "Body",
              filePath: "src/example.ts",
              line: 2,
              managedFindingId: 7,
            },
            {
              severity: "medium",
              confidence: "high",
              title: "Duplicate link",
              body: "Body",
              filePath: "src/example.ts",
              line: 3,
              managedFindingId: 7,
            },
            {
              severity: "medium",
              confidence: "high",
              title: "Unknown link",
              body: "Body",
              filePath: "src/example.ts",
              line: 4,
              managedFindingId: 99,
            },
          ],
          resolvedManagedFindingIds: [99, 7, 8, 8],
          unmappedNotes: [],
        },
        new Map([["src/example.ts", new Set([2, 3, 4])]]),
        new Set([7, 8]),
      ),
    )

    expect(result.findings[0]?.managedFindingId).toBe(7)
    expect(result.findings[1]?.managedFindingId).toBeUndefined()
    expect(result.findings[2]?.managedFindingId).toBeUndefined()
    expect(result.resolvedManagedFindingIds).toEqual([8])
  })
})
