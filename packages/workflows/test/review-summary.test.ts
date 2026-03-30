import { describe, expect, test } from "bun:test"

import {
  buildReviewSummarySubjects,
  renderReviewSummaryFallback,
  validateReviewSummaryPassOutput,
} from "../src/review/ReviewSummary"
import { makeNormalizedReviewResult, makeReviewFinding } from "./helpers"

describe("review summary", () => {
  test("builds summary subjects for inline findings, summary-only findings, unmapped notes, and carried-forward findings", () => {
    const inlineFinding = makeReviewFinding({
      title: "Inline finding",
    })
    const summaryOnlyFinding = makeReviewFinding({
      title: "Summary-only finding",
      filePath: "src/other.ts",
      line: 9,
    })
    const carriedForwardFinding = makeReviewFinding({
      title: "Carried forward finding",
      filePath: "src/legacy.ts",
      line: 20,
    })

    const subjects = buildReviewSummarySubjects({
      reviewResult: {
        ...makeNormalizedReviewResult([inlineFinding, summaryOnlyFinding], [inlineFinding]),
        findings: [{ ...carriedForwardFinding, managedFindingId: 11 }, inlineFinding, summaryOnlyFinding],
        inlineFindings: [{ ...carriedForwardFinding, managedFindingId: 11 }, inlineFinding],
        summaryOnlyFindings: [summaryOnlyFinding],
        unmappedNotes: ["Needs wider validation"],
      },
      retainedFindings: [
        {
          existingThreadId: 11,
          finding: { ...carriedForwardFinding, managedFindingId: 11 },
          retentionReason: "outside-scope",
        },
      ],
    })

    expect(subjects.map((subject) => [subject.id, subject.kind, subject.title, subject.retentionReason])).toEqual([
      ["inline-finding-1", "inline-finding", "Inline finding", undefined],
      ["summary-only-finding-1", "summary-only-finding", "Summary-only finding", undefined],
      ["unmapped-note-1", "unmapped-note", "Needs wider validation", undefined],
      ["carried-forward-finding-1", "carried-forward-finding", "Carried forward finding", "outside-scope"],
    ])
  })

  test("validates grouped subject ids", () => {
    const subjects = buildReviewSummarySubjects({
      reviewResult: {
        ...makeNormalizedReviewResult([
          makeReviewFinding({ title: "One" }),
          makeReviewFinding({ title: "Two", line: 3 }),
        ]),
        unmappedNotes: [],
      },
    })

    const validation = validateReviewSummaryPassOutput({
      subjects,
      output: {
        highlights: [
          {
            subjectIds: [subjects[0]!.id, subjects[1]!.id],
            text: "Both issues stem from the same regression.",
          },
        ],
      },
    })

    expect(validation.ok).toBe(true)
  })

  test("rejects unknown summary subject ids", () => {
    const subjects = buildReviewSummarySubjects({
      reviewResult: makeNormalizedReviewResult([makeReviewFinding()]),
    })

    const validation = validateReviewSummaryPassOutput({
      subjects,
      output: {
        highlights: [
          {
            subjectIds: ["missing-subject"],
            text: "Unknown issue.",
          },
        ],
      },
    })

    expect(validation.ok).toBe(false)
    expect(validation.ok ? [] : validation.issues[0]).toContain("unknown subject ID")
  })

  test("rejects duplicate ids across highlight groups", () => {
    const subjects = buildReviewSummarySubjects({
      reviewResult: {
        ...makeNormalizedReviewResult([makeReviewFinding(), makeReviewFinding({ title: "Two", line: 3 })]),
        unmappedNotes: [],
      },
    })

    const validation = validateReviewSummaryPassOutput({
      subjects,
      output: {
        highlights: [
          {
            subjectIds: [subjects[0]!.id],
            text: "First mention.",
          },
          {
            subjectIds: [subjects[0]!.id],
            text: "Second mention.",
          },
        ],
      },
    })

    expect(validation.ok).toBe(false)
    expect(validation.ok ? [] : validation.issues[0]).toContain("appeared in more than one highlight")
  })

  test("rejects empty highlight lists when subjects exist", () => {
    const subjects = buildReviewSummarySubjects({
      reviewResult: makeNormalizedReviewResult([makeReviewFinding()]),
    })

    const validation = validateReviewSummaryPassOutput({
      subjects,
      output: {
        highlights: [],
      },
    })

    expect(validation.ok).toBe(false)
    expect(validation.ok ? [] : validation.issues[0]).toContain("at least one highlight")
  })

  test("renders a deterministic fallback summary from subjects only", () => {
    const inlineFinding = makeReviewFinding({
      title: "Current issue",
    })
    const carriedForwardFinding = makeReviewFinding({
      title: "Older issue",
      filePath: "src/legacy.ts",
      line: 20,
    })

    const subjects = buildReviewSummarySubjects({
      reviewResult: {
        ...makeNormalizedReviewResult([inlineFinding], [inlineFinding]),
        findings: [{ ...carriedForwardFinding, managedFindingId: 8 }, inlineFinding],
        inlineFindings: [{ ...carriedForwardFinding, managedFindingId: 8 }, inlineFinding],
      },
      retainedFindings: [
        {
          existingThreadId: 8,
          finding: { ...carriedForwardFinding, managedFindingId: 8 },
          retentionReason: "outside-scope",
        },
      ],
    })

    const summary = renderReviewSummaryFallback({
      verdict: "concerns",
      reviewMode: "follow-up",
      subjects,
    })

    expect(summary).toContain("⚠️ Review verdict: concerns. 2 findings.")
    expect(summary).toContain("1 finding is carried forward from earlier managed reviews outside this follow-up diff.")
    expect(summary).toContain("- Current issue (src/example.ts:2)")
    expect(summary).toContain("- Still tracking outside scope: Older issue (src/legacy.ts:20)")
  })

  test("describes earlier managed findings that remain open after the rerun", () => {
    const retainedFinding = makeReviewFinding({
      title: "Earlier issue",
      filePath: "src/example.ts",
      line: 4,
      managedFindingId: 9,
    })

    const subjects = buildReviewSummarySubjects({
      reviewResult: {
        ...makeNormalizedReviewResult([retainedFinding], [retainedFinding]),
        findings: [retainedFinding],
        inlineFindings: [retainedFinding],
      },
      retainedFindings: [
        {
          existingThreadId: 9,
          finding: retainedFinding,
          retentionReason: "unresolved-existing",
        },
      ],
    })

    const summary = renderReviewSummaryFallback({
      verdict: "concerns",
      reviewMode: "full",
      subjects,
    })

    expect(summary).toContain("1 earlier managed finding still remains open after this rerun.")
    expect(summary).toContain("- Still open from an earlier managed review: Earlier issue (src/example.ts:4)")
  })
})
