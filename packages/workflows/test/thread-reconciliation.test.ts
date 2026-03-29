import { describe, expect, test } from "bun:test"

import {
  buildInlineComment,
  buildSummaryComment,
  findManagedSummaryThread,
  listManagedFindingThreads,
  mergeFollowUpReviewResult,
  reconcileThreads,
} from "../src/review/ThreadReconciliation"

import {
  makeManagedReviewState,
  makeManagedFindingThread,
  makeManagedSummaryThread,
  makeReviewFinding,
  makeReviewHistoryEntry,
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

  test("renders a review cost history table when present", () => {
    const reviewState = makeManagedReviewState({
      reviewHistory: [
        makeReviewHistoryEntry(),
        makeReviewHistoryEntry({
          reviewedAt: "2026-03-21T16:45:00.000Z",
          reviewedCommit: "follow-up-sha",
          reviewMode: "follow-up",
          costUsd: 0.0456,
          tokens: {
            input: 900,
            output: 120,
            reasoning: 50,
            cacheRead: 10,
            cacheWrite: 0,
          },
        }),
      ],
    })

    const summaryContent = buildSummaryComment(makeSummarySnapshot({}, reviewState))

    expect(summaryContent).toContain("| Review | Reviewed At (UTC) | Mode | Model | Tokens | Cost |")
    expect(summaryContent).toContain("$0.1234")
    expect(summaryContent).toContain("$0.0456")
    expect(summaryContent).toContain("Mar 21, 2026, 16:45")
    expect(summaryContent).toContain("input 900, output 120, reasoning 50, cache read 10")
    const historyRows = summaryContent.split("\n").filter((line) => line.startsWith("| [Build "))

    expect(historyRows[0]).toContain("follow-up-sh")
    expect(historyRows[1]).toContain("reviewed-sha")
  })

  test("decodes legacy v1 summary comments without review history", () => {
    const legacyReviewState = {
      ...makeManagedReviewState(),
      schemaVersion: 1,
    }
    delete legacyReviewState.reviewHistory

    const thread = makeManagedSummaryThread(legacyReviewState)

    const decoded = findManagedSummaryThread([thread])?.reviewState
    expect(decoded?.schemaVersion).toBe(1)
    expect(decoded?.reviewHistory).toBeUndefined()
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

  test("lists managed finding threads with decoded finding state and thread metadata", () => {
    const finding = makeReviewFinding({
      title: "Existing finding",
      filePath: "src/legacy.ts",
      line: 7,
    })

    const managedFinding = listManagedFindingThreads([makeManagedFindingThread(finding, 12, 2)])[0]

    expect(managedFinding?.thread.id).toBe(12)
    expect(managedFinding?.thread.status).toBe(2)
    expect(managedFinding?.commentId).toBe(120)
    expect(managedFinding?.filePath).toBe("/src/legacy.ts")
    expect(managedFinding?.line).toBe(7)
    expect(managedFinding?.finding.title).toBe("Existing finding")
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
        verdict: "pass",
        findings: [currentFinding],
        inlineFindings: [currentFinding],
        summaryOnlyFindings: [],
        unmappedNotes: [],
      },
    })

    expect(result.reviewResult.verdict).toBe("concerns")
    expect(result.reviewResult.findings.map((finding) => finding.title)).toEqual(["Earlier finding", "Current finding"])
    expect(result.reviewResult.inlineFindings.map((finding) => finding.title)).toEqual([
      "Earlier finding",
      "Current finding",
    ])
    expect(result.carriedForwardFindings.map((finding) => finding.title)).toEqual(["Earlier finding"])
    expect(result.carriedForwardFindingsCount).toBe(1)
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
        verdict: "pass",
        findings: [],
        inlineFindings: [],
        summaryOnlyFindings: [],
        unmappedNotes: [],
      },
    })

    expect(result.reviewResult.verdict).toBe("concerns")
    expect(result.reviewResult.findings.map((finding) => finding.title)).toEqual(["Untouched finding"])
    expect(result.reviewResult.inlineFindings.map((finding) => finding.title)).toEqual(["Untouched finding"])
    expect(result.carriedForwardFindings.map((finding) => finding.title)).toEqual(["Untouched finding"])
    expect(result.carriedForwardFindingsCount).toBe(1)
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
