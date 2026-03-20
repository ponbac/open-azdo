import { describe, expect, test } from "bun:test"

import {
  buildInlineComment,
  buildSummaryComment,
  findManagedSummaryThread,
  mergeFollowUpReviewResult,
  reconcileThreads,
} from "../src/review/ThreadReconciliation"

import {
  makeManagedReviewState,
  makeManagedFindingThread,
  makeManagedSummaryThread,
  makeReviewFinding,
  makeSummarySnapshot,
} from "./helpers"

describe("thread reconciliation", () => {
  test("round-trips managed review state through the summary comment", () => {
    const reviewState = makeManagedReviewState({
      reviewedCommit: "next-sha",
      pullRequestBaseRef: "base-sha",
    })
    const thread = makeManagedSummaryThread(reviewState)

    expect(findManagedSummaryThread([thread])?.reviewState).toEqual(reviewState)
  })

  test("renders summary comments with embedded review state", () => {
    const summaryContent = buildSummaryComment(makeSummarySnapshot())

    expect(summaryContent).toContain("Verdict: **concerns**")
    expect(summaryContent).toContain("<!-- open-azdo-review:")
  })

  test("renders markdown-friendly inline comments with fenced suggestions", () => {
    const content = buildInlineComment(
      makeReviewFinding({
        suggestion: "const next = computeValue()",
      }),
    )

    expect(content).toContain("**Severity:** high")
    expect(content).toContain("**Confidence:** high")
    expect(content).toContain("Suggestion:")
    expect(content).toContain("```")
    expect(content).toContain("const next = computeValue()")
  })

  test("only closes stale findings that intersect the follow-up changed lines", () => {
    const activeFinding = makeReviewFinding({
      title: "New finding",
      line: 5,
    })
    const intersectingStaleFinding = makeReviewFinding({
      title: "Intersecting stale",
      line: 2,
    })
    const untouchedStaleFinding = makeReviewFinding({
      title: "Untouched stale",
      filePath: "src/other.ts",
      line: 20,
    })

    const actions = reconcileThreads({
      existingThreads: [
        makeManagedSummaryThread(),
        makeManagedFindingThread(intersectingStaleFinding, 3),
        makeManagedFindingThread(untouchedStaleFinding, 4),
      ],
      summaryContent: buildSummaryComment(makeSummarySnapshot()),
      inlineFindings: [activeFinding],
      reviewMode: "follow-up",
      scopedChangedLinesByFile: new Map([
        ["src/example.ts", new Set([2, 5])],
        ["src/other.ts", new Set([99])],
      ]),
      scopedDeletedLinesByFile: new Map(),
    })

    expect(actions.map((action) => action.type)).toEqual(["upsert-summary", "upsert-finding", "close-thread"])
    const closedThread = actions.find((action) => action.type === "close-thread")
    expect(closedThread && "existingThread" in closedThread ? closedThread.existingThread.id : undefined).toBe(3)
  })

  test("keeps untouched open findings in the follow-up summary result", () => {
    const carriedForwardFinding = makeReviewFinding({
      title: "Earlier finding",
      filePath: "src/other.ts",
      line: 20,
    })
    const currentFinding = makeReviewFinding({
      title: "Current finding",
      line: 5,
    })

    const result = mergeFollowUpReviewResult({
      existingThreads: [
        makeManagedFindingThread(carriedForwardFinding, 2),
        makeManagedFindingThread(makeReviewFinding({ title: "Closed finding", line: 99 }), 3, 2),
      ],
      scopedChangedLinesByFile: new Map([
        ["src/example.ts", new Set([5])],
        ["src/other.ts", new Set([99])],
      ]),
      scopedDeletedLinesByFile: new Map(),
      reviewResult: {
        summary: "Current summary",
        verdict: "pass",
        findings: [currentFinding],
        inlineFindings: [currentFinding],
        summaryOnlyFindings: [],
        unmappedNotes: [],
      },
    })

    expect(result.verdict).toBe("concerns")
    expect(result.findings.map((finding) => finding.title)).toEqual(["Earlier finding", "Current finding"])
    expect(result.inlineFindings.map((finding) => finding.title)).toEqual(["Earlier finding", "Current finding"])
    expect(result.summary).toContain("Still tracking 1 managed finding")
  })

  test("closes stale findings when the follow-up only deletes the previously annotated line", () => {
    const staleFinding = makeReviewFinding({
      title: "Deleted finding",
      line: 20,
    })

    const actions = reconcileThreads({
      existingThreads: [makeManagedSummaryThread(), makeManagedFindingThread(staleFinding, 3)],
      summaryContent: buildSummaryComment(makeSummarySnapshot()),
      inlineFindings: [],
      reviewMode: "follow-up",
      scopedChangedLinesByFile: new Map(),
      scopedDeletedLinesByFile: new Map([["src/example.ts", new Set([20])]]),
    })

    expect(actions.map((action) => action.type)).toEqual(["upsert-summary", "close-thread"])
    const closedThread = actions.find((action) => action.type === "close-thread")
    expect(closedThread && "existingThread" in closedThread ? closedThread.existingThread.id : undefined).toBe(3)
  })

  test("does not carry forward stale findings when a deleted range intersects them", () => {
    const deletedRangeFinding = makeReviewFinding({
      title: "Range finding",
      line: 40,
      endLine: 42,
    })
    const untouchedFinding = makeReviewFinding({
      title: "Untouched finding",
      filePath: "src/other.ts",
      line: 80,
    })

    const result = mergeFollowUpReviewResult({
      existingThreads: [
        makeManagedFindingThread(deletedRangeFinding, 2),
        makeManagedFindingThread(untouchedFinding, 3),
      ],
      scopedChangedLinesByFile: new Map(),
      scopedDeletedLinesByFile: new Map([["src/example.ts", new Set([41])]]),
      reviewResult: {
        summary: "Current summary",
        verdict: "pass",
        findings: [],
        inlineFindings: [],
        summaryOnlyFindings: [],
        unmappedNotes: [],
      },
    })

    expect(result.verdict).toBe("concerns")
    expect(result.findings.map((finding) => finding.title)).toEqual(["Untouched finding"])
    expect(result.inlineFindings.map((finding) => finding.title)).toEqual(["Untouched finding"])
    expect(result.summary).toContain("Still tracking 1 managed finding")
  })

  test("skipped mode only updates the summary thread", () => {
    const actions = reconcileThreads({
      existingThreads: [makeManagedSummaryThread(), makeManagedFindingThread(makeReviewFinding(), 2)],
      summaryContent: buildSummaryComment(makeSummarySnapshot()),
      inlineFindings: [makeReviewFinding()],
      reviewMode: "skipped",
      scopedChangedLinesByFile: new Map([["src/example.ts", new Set([2])]]),
      scopedDeletedLinesByFile: new Map(),
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]?.type).toBe("upsert-summary")
  })
})
