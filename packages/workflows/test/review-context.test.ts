import { describe, expect, test } from "bun:test"

import { type PullRequestDiff } from "@open-azdo/core/git"
import { buildReviewContext } from "@open-azdo/workflows/review"

describe("review context", () => {
  test("builds a compact manifest with refs, line ranges, and hunk headers", () => {
    const diffText = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,3 +1,5 @@",
      " export const value = 1",
      "+export const next = 2",
      "+export const another = 3",
      "diff --git a/src/other.ts b/src/other.ts",
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -10,1 +10,2 @@ export function run() {",
      "+  return true",
    ].join("\n")

    const gitDiff: PullRequestDiff = {
      baseRef: "abc123",
      headRef: "HEAD",
      diffText,
      changedFiles: ["src/example.ts", "src/other.ts"],
      changedLinesByFile: new Map([
        ["src/example.ts", new Set([2, 3, 8, 9])],
        ["src/other.ts", new Set([10])],
      ]),
    }

    const context = buildReviewContext(
      {
        title: "Feature PR",
        description: "Adds a new export",
      },
      gitDiff,
    )

    expect(context.baseRef).toBe("abc123")
    expect(context.headRef).toBe("HEAD")
    expect(context.changedFiles).toEqual([
      {
        path: "src/example.ts",
        changedLineRanges: [
          { start: 2, end: 3 },
          { start: 8, end: 9 },
        ],
        hunkHeaders: ["@@ -1,3 +1,5 @@"],
      },
      {
        path: "src/other.ts",
        changedLineRanges: [{ start: 10, end: 10 }],
        hunkHeaders: ["@@ -10,1 +10,2 @@ export function run() {"],
      },
    ])
  })

  test("does not embed full patches or file contents in the manifest", () => {
    const largeLine = `+${"x".repeat(200)}`
    const diffText = [
      "diff --git a/src/huge.ts b/src/huge.ts",
      "--- a/src/huge.ts",
      "+++ b/src/huge.ts",
      "@@ -1,1 +1,200 @@",
      ...Array.from({ length: 200 }, () => largeLine),
    ].join("\n")

    const context = buildReviewContext(
      {
        title: "Large PR",
        description: "Touches one big file",
      },
      {
        baseRef: "base",
        headRef: "HEAD",
        diffText,
        changedFiles: ["src/huge.ts"],
        changedLinesByFile: new Map([["src/huge.ts", new Set(Array.from({ length: 200 }, (_, index) => index + 1))]]),
      },
    )

    const serialized = JSON.stringify(context)

    expect(serialized).not.toContain(largeLine)
    expect(serialized).not.toContain("--- a/src/huge.ts")
    expect(serialized).not.toContain("+++ b/src/huge.ts")
  })
})
