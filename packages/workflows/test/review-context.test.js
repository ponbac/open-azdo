import { describe, expect, test } from "bun:test"
import { buildReviewContext } from "../src/review/ReviewContext"
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
    const gitDiff = {
      baseRef: "abc123",
      headRef: "HEAD",
      diffText,
      changedFiles: ["src/example.ts", "src/other.ts"],
      changedLinesByFile: new Map([
        ["src/example.ts", new Set([2, 3, 8, 9])],
        ["src/other.ts", new Set([10])],
      ]),
      deletedLinesByFile: new Map(),
    }
    const context = buildReviewContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
      },
      reviewMode: "full",
      pullRequestBaseRef: "abc123",
      gitDiff,
    })
    expect(context.reviewMode).toBe("full")
    expect(context.pullRequestBaseRef).toBe("abc123")
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
  test("includes follow-up review metadata when present", () => {
    const context = buildReviewContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
      },
      reviewMode: "follow-up",
      previousReviewedCommit: "prev123",
      pullRequestBaseRef: "pr-base",
      gitDiff: {
        baseRef: "prev123",
        headRef: "next456",
        diffText: [
          "diff --git a/src/example.ts b/src/example.ts",
          "--- a/src/example.ts",
          "+++ b/src/example.ts",
          "@@ -1,1 +1,2 @@",
          "+export const next = 2",
        ].join("\n"),
        changedFiles: ["src/example.ts"],
        changedLinesByFile: new Map([["src/example.ts", new Set([1])]]),
        deletedLinesByFile: new Map(),
      },
    })
    expect(context.reviewMode).toBe("follow-up")
    expect(context.previousReviewedCommit).toBe("prev123")
    expect(context.pullRequestBaseRef).toBe("pr-base")
    expect(context.baseRef).toBe("prev123")
    expect(context.headRef).toBe("next456")
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
    const context = buildReviewContext({
      metadata: {
        title: "Large PR",
        description: "Touches one big file",
      },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        diffText,
        changedFiles: ["src/huge.ts"],
        changedLinesByFile: new Map([["src/huge.ts", new Set(Array.from({ length: 200 }, (_, index) => index + 1))]]),
        deletedLinesByFile: new Map(),
      },
    })
    const serialized = JSON.stringify(context)
    expect(serialized).not.toContain(largeLine)
    expect(serialized).not.toContain("--- a/src/huge.ts")
    expect(serialized).not.toContain("+++ b/src/huge.ts")
  })
})
