import { describe, expect, test } from "bun:test"
import type { ExistingThread } from "@open-azdo/azdo/schemas"

import {
  buildInlineComment,
  buildSummaryComment,
  decodeManagedThreads,
  mergeManagedReviewResult,
  reconcileThreads,
} from "../src/review/ThreadReconciliation"

import {
  BOT_ID,
  makeManagedReviewState,
  makeManagedFindingThread,
  makeManagedSummaryThread,
  makeReviewFinding,
  makeReviewHistoryEntry,
  makeSummarySnapshot,
} from "./helpers"

describe("thread reconciliation", () => {
  test.each([
    ["bot", BOT_ID, false, false, true],
    ["human", "human-id", false, false, false],
    ["deleted bot comment", BOT_ID, true, false, false],
    ["deleted bot thread", BOT_ID, false, true, false],
  ] as const)(
    "recognizes failure-only identity from %s without granting a checkpoint",
    (_scenario, authorId, deletedComment, deletedThread, trusted) => {
      const comment = {
        id: 10,
        author: { id: authorId },
        isDeleted: deletedComment,
        content: 'Failed\n<!-- open-azdo-failure:{"kind":"failure"} -->',
      }

      const managed = decodeManagedThreads(
        [{ id: 1, status: 1, isDeleted: deletedThread, comments: [comment] }],
        BOT_ID,
      )

      expect(managed.failure?.thread.id).toBe(trusted ? 1 : undefined)
      expect(managed.summary).toBeUndefined()
      expect(managed.findings).toEqual([])
      expect(managed.comments.has(comment)).toBe(trusted)
    },
  )

  test("round-trips managed review state through the summary comment", () => {
    const reviewState = makeManagedReviewState({
      reviewedCommit: "next-sha",
      pullRequestBaseRef: "base-sha",
    })

    const thread = makeManagedSummaryThread(reviewState)

    expect(decodeManagedThreads([thread], BOT_ID).summary?.reviewState).toEqual(reviewState)
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
    // This persisted v1 payload must stay independent of the current state builder and encoder.
    const thread: ExistingThread = {
      id: 1,
      status: 1,
      comments: [
        {
          id: 10,
          author: { id: BOT_ID },
          content:
            'Verdict: **concerns**\n\n<!-- open-azdo-review:{"schemaVersion":1,"reviewedCommit":"legacy-sha","pullRequestBaseRef":"legacy-base","verdict":"concerns","severityCounts":{"low":0,"medium":0,"high":1,"critical":0},"findingsCount":1,"inlineFindingsCount":1,"unmappedNotesCount":0} -->',
        },
      ],
    }

    const decoded = decodeManagedThreads([thread], BOT_ID).summary?.reviewState

    expect(decoded).toEqual({
      schemaVersion: 1,
      reviewedCommit: "legacy-sha",
      pullRequestBaseRef: "legacy-base",
      verdict: "concerns",
      severityCounts: { low: 0, medium: 0, high: 1, critical: 0 },
      findingsCount: 1,
      inlineFindingsCount: 1,
      unmappedNotesCount: 0,
    })
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
      body: `flow: A --> B\n${buildSummaryComment(makeSummarySnapshot())}`,
      suggestion: "<!-- note -->",
    })

    const managedThreads = decodeManagedThreads([makeManagedFindingThread(finding, 12, 2)], BOT_ID)
    const managedFinding = managedThreads.findings[0]

    expect(managedFinding?.thread.id).toBe(12)
    expect(managedFinding?.thread.status).toBe(2)
    expect(managedFinding?.commentId).toBe(120)
    expect(managedFinding?.filePath).toBe("/src/legacy.ts")
    expect(managedFinding?.line).toBe(7)
    expect(managedFinding?.finding).toEqual(finding)
    expect(managedThreads.summary).toBeUndefined()
  })

  test("updates an explicitly linked managed finding thread even when the wording changed", () => {
    const currentFinding = makeReviewFinding({
      title: "Updated wording",
      body: "Fresh repository evidence with new wording.",
      managedFindingId: 3,
      line: 5,
    })

    const previousFinding = makeReviewFinding({
      title: "Old wording",
      body: "Older phrasing.",
      line: 2,
    })

    const actions = reconcileThreads({
      managedThreads: decodeManagedThreads(
        [makeManagedSummaryThread(), makeManagedFindingThread(previousFinding, 3)],
        BOT_ID,
      ),
      summaryContent: buildSummaryComment(makeSummarySnapshot()),
      summaryVerdict: "concerns",
      inlineFindings: [currentFinding],
      resolvedManagedFindingIds: [],
      reviewMode: "follow-up",
      scopedChangedLinesByFile: new Map([["src/example.ts", new Set([2, 5])]]),
      scopedDeletedLinesByFile: new Map(),
    })

    expect(actions.map((action) => action.type)).toEqual(["upsert-finding", "upsert-summary"])
    const findingAction = actions.find((action) => action.type === "upsert-finding")
    expect(findingAction && "existingThread" in findingAction ? findingAction.existingThread?.id : undefined).toBe(3)
  })

  test("retains untouched out-of-scope findings in the outstanding result", () => {
    const retainedFinding = makeReviewFinding({
      title: "Earlier finding",
      filePath: "src/other.ts",
      line: 20,
    })

    const currentFinding = makeReviewFinding({
      title: "Current finding",
      line: 5,
    })

    const result = mergeManagedReviewResult({
      managedThreads: decodeManagedThreads(
        [
          makeManagedFindingThread(retainedFinding, 2),
          makeManagedFindingThread(makeReviewFinding({ title: "Closed finding", line: 99 }), 3, 2),
        ],
        BOT_ID,
      ),
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
        resolvedManagedFindingIds: [],
        unmappedNotes: [],
      },
    })

    expect(result.reviewResult.verdict).toBe("concerns")
    expect(result.reviewResult.findings.map((finding) => finding.title)).toEqual(["Earlier finding", "Current finding"])
    expect(result.reviewResult.inlineFindings.map((finding) => finding.title)).toEqual([
      "Earlier finding",
      "Current finding",
    ])
    expect(result.retainedFindings).toEqual([
      {
        existingThreadId: 2,
        finding: { ...retainedFinding, managedFindingId: 2 },
        retentionReason: "outside-scope",
      },
    ])
    expect(result.retainedFindingsCount).toBe(1)
  })

  test.each([
    ["unchanged", "src/example.ts", 20, 20],
    ["moved", "src/moved.ts", 30, 30],
    ["moved start-only", "src/moved.ts", 30, undefined],
    ["literal backslash", "back\\slash.ts", 20, 20],
  ] as const)("closes explicitly resolved findings with %s coordinates", (_scenario, filePath, line, endLine) => {
    const resolvedFinding = makeReviewFinding({
      title: "Resolved finding",
      line: 20,
      endLine: 22,
    })

    let threadContext: NonNullable<ExistingThread["threadContext"]> = {
      filePath: `/${filePath}`,
      rightFileStart: { line },
    }

    if (endLine !== undefined) {
      threadContext = { ...threadContext, rightFileEnd: { line: endLine } }
    }

    const actions = reconcileThreads({
      managedThreads: decodeManagedThreads(
        [
          makeManagedSummaryThread(),
          {
            ...makeManagedFindingThread(resolvedFinding, 3),
            threadContext,
          },
        ],
        BOT_ID,
      ),
      summaryContent: buildSummaryComment(makeSummarySnapshot()),
      summaryVerdict: "concerns",
      inlineFindings: [],
      resolvedManagedFindingIds: [3],
      reviewMode: "follow-up",
      scopedChangedLinesByFile: new Map(),
      scopedDeletedLinesByFile: new Map([[filePath, new Set([line])]]),
    })

    expect(actions.map((action) => action.type)).toEqual(["close-thread", "upsert-summary"])
    const closedThread = actions.find((action) => action.type === "close-thread")
    expect(closedThread && "existingThread" in closedThread ? closedThread.existingThread.id : undefined).toBe(3)
  })

  test("retains in-scope managed findings that were neither linked nor resolved", () => {
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

    const result = mergeManagedReviewResult({
      managedThreads: decodeManagedThreads(
        [makeManagedFindingThread(deletedRangeFinding, 2), makeManagedFindingThread(untouchedFinding, 3)],
        BOT_ID,
      ),
      scopedChangedLinesByFile: new Map(),
      scopedDeletedLinesByFile: new Map([["src/example.ts", new Set([41])]]),
      reviewResult: {
        verdict: "pass",
        findings: [],
        inlineFindings: [],
        summaryOnlyFindings: [],
        resolvedManagedFindingIds: [],
        unmappedNotes: [],
      },
    })

    expect(result.reviewResult.verdict).toBe("concerns")
    expect(result.reviewResult.findings.map((finding) => finding.title)).toEqual(["Untouched finding", "Range finding"])
    expect(result.reviewResult.inlineFindings.map((finding) => finding.title)).toEqual([
      "Untouched finding",
      "Range finding",
    ])
    expect(result.retainedFindings).toEqual([
      {
        existingThreadId: 3,
        finding: { ...untouchedFinding, managedFindingId: 3 },
        retentionReason: "outside-scope",
      },
      {
        existingThreadId: 2,
        finding: { ...deletedRangeFinding, managedFindingId: 2 },
        retentionReason: "unresolved-existing",
      },
    ])
    expect(result.retainedFindingsCount).toBe(2)
  })

  test("ignores unknown, duplicate, and conflicting resolution ids during reconciliation", () => {
    const linkedFinding = makeReviewFinding({
      title: "Linked finding",
      managedFindingId: 2,
    })

    const explicitlyResolvedFinding = makeReviewFinding({
      title: "Resolved finding",
      line: 3,
    })

    const actions = reconcileThreads({
      managedThreads: decodeManagedThreads(
        [
          makeManagedSummaryThread(),
          makeManagedFindingThread(linkedFinding, 2),
          makeManagedFindingThread(explicitlyResolvedFinding, 3),
        ],
        BOT_ID,
      ),
      summaryContent: buildSummaryComment(makeSummarySnapshot()),
      summaryVerdict: "concerns",
      inlineFindings: [linkedFinding],
      resolvedManagedFindingIds: [999, 2, 3, 3],
      reviewMode: "full",
      scopedChangedLinesByFile: new Map([["src/example.ts", new Set([2, 3])]]),
      scopedDeletedLinesByFile: new Map(),
    })

    expect(actions.map((action) => action.type)).toEqual(["upsert-finding", "close-thread", "upsert-summary"])
    const closedThread = actions.find((action) => action.type === "close-thread")
    expect(closedThread && "existingThread" in closedThread ? closedThread.existingThread.id : undefined).toBe(3)
  })

  test("skipped mode only updates the summary thread", () => {
    const actions = reconcileThreads({
      managedThreads: decodeManagedThreads(
        [makeManagedSummaryThread(), makeManagedFindingThread(makeReviewFinding(), 2)],
        BOT_ID,
      ),
      summaryContent: buildSummaryComment(makeSummarySnapshot()),
      summaryVerdict: "concerns",
      inlineFindings: [makeReviewFinding()],
      resolvedManagedFindingIds: [],
      reviewMode: "skipped",
      scopedChangedLinesByFile: new Map([["src/example.ts", new Set([2])]]),
      scopedDeletedLinesByFile: new Map(),
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]?.type).toBe("upsert-summary")
  })
})
