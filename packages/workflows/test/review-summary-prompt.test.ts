import { describe, expect, test } from "bun:test"

import { buildReviewSummaryPrompt } from "../src/review/ReviewSummaryPrompt"
import type { ReviewSummarySubject } from "../src/review/ReviewSummary"

const subjects: ReadonlyArray<ReviewSummarySubject> = [
  {
    id: "inline-finding-1",
    kind: "inline-finding",
    title: "Use the updated value",
    body: "The change returns stale state.",
    severity: "high",
    confidence: "high",
    filePath: "src/example.ts",
    line: 2,
  },
  {
    id: "unmapped-note-1",
    kind: "unmapped-note",
    title: "Needs wider validation",
    body: "Needs wider validation",
  },
]

describe("review summary prompt", () => {
  test("uses structured subjects only and prohibits repo inspection and tool use", () => {
    const prompt = buildReviewSummaryPrompt(subjects)

    expect(prompt).toContain("You are not reviewing the repository.")
    expect(prompt).toContain("Do not inspect the repo, diff, pull request, work items, or thread bodies.")
    expect(prompt).toContain("Do not use tools or ask to use tools.")
    expect(prompt).toContain("Do not introduce any issue, risk, or concern that is not present in the subject list.")
    expect(prompt).toContain('"subjectIds":["subject-id"]')
    expect(prompt).toContain('"id":"inline-finding-1"')
    expect(prompt).not.toContain('"pullRequest"')
    expect(prompt).not.toContain("git diff")
  })
})
