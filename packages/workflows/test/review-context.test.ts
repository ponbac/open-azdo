import { describe, expect, test } from "bun:test"

import type { ExistingThread } from "@open-azdo/azdo/schemas"
import { type PullRequestDiff } from "@open-azdo/core/git"
import { buildReviewContext } from "../src/review/ReviewContext"
import { normalizeReviewResult } from "../src/review/ReviewOutput"

import { decodeManagedThreads } from "../src/review/ThreadReconciliation"
import { BOT_ID, makeManagedFindingThread, makeManagedSummaryThread, makeReviewFinding } from "./helpers"

const buildContext = (input: Omit<Parameters<typeof buildReviewContext>[0], "managedThreads">) =>
  buildReviewContext({
    ...input,
    managedThreads: decodeManagedThreads(input.existingThreads ?? [], BOT_ID),
  })

const makeThreadComment = (
  overrides: Partial<ExistingThread["comments"][number]> = {},
): ExistingThread["comments"][number] => ({
  id: 1,
  content: "Reviewer comment",
  publishedDate: "2026-03-21T10:00:00.000Z",
  commentType: "text",
  author: {
    displayName: "Reviewer",
  },
  ...overrides,
})

const makeThread = (overrides: Partial<ExistingThread> = {}): ExistingThread => ({
  id: 1,
  status: "active",
  comments: [makeThreadComment()],
  ...overrides,
})

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
      changedFiles: ["src/example.ts", "src/other.ts", "image.bin", "src/new-name.ts", "empty.txt"],
      changedLinesByFile: new Map([
        ["src/example.ts", new Set([2, 3, 8, 9])],
        ["src/other.ts", new Set([10])],
      ]),
      deletedFiles: ["src/removed.ts", "empty-old.txt"],
      renamedFromByFile: new Map([["src/new-name.ts", "src/old-name.ts"]]),
      deletedLinesByFile: new Map(),
    }

    const context = buildContext({
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
      { path: "image.bin", changedLineRanges: [], hunkHeaders: [] },
      { path: "src/new-name.ts", renamedFrom: "src/old-name.ts", changedLineRanges: [], hunkHeaders: [] },
      { path: "empty.txt", changedLineRanges: [], hunkHeaders: [] },
    ])
    expect(context.deletedFiles).toEqual(["src/removed.ts", "empty-old.txt"])
  })

  test("clips per-file manifest detail without changing the authoritative line map", () => {
    const lines = Array.from({ length: 500 }, (_, index) => index * 10 + 1)
    const changedLines = new Set(lines)
    const changedLinesByFile = new Map([["src/scattered.ts", changedLines]])

    const context = buildContext({
      metadata: { title: "Scattered changes", description: "One file with many hunks" },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        changedFiles: ["src/scattered.ts"],
        deletedFiles: [],
        renamedFromByFile: new Map(),
        changedLinesByFile,
        deletedLinesByFile: new Map(),
        diffText: [
          "diff --git a/src/scattered.ts b/src/scattered.ts",
          "--- a/src/scattered.ts",
          "+++ b/src/scattered.ts",
          ...lines.map((line) => `@@ -${line} +${line} @@\n-old\n+new`),
        ].join("\n"),
      },
    })

    expect(context.changedFiles[0]?.changedLineRanges).toHaveLength(100)
    expect(context.changedFiles[0]?.hunkHeaders).toHaveLength(100)
    expect(context.diffMetadataTruncated).toBe(true)

    const finding = makeReviewFinding({ filePath: "src/scattered.ts", line: 4_991 })

    const normalized = normalizeReviewResult(
      { verdict: "concerns", findings: [finding], resolvedManagedFindingIds: [], unmappedNotes: [] },
      changedLinesByFile,
    )

    expect(normalized.inlineFindings).toEqual([finding])
    expect(normalized.summaryOnlyFindings).toEqual([])
  })

  test.each([0, 80])("keeps every path when a wide manifest drops optional detail (path padding %i)", (padding) => {
    const paths = Array.from({ length: 5_000 }, (_, index) => `src/${"x".repeat(padding)}file-${index}.ts`)

    const context = buildContext({
      metadata: { title: "Wide changes", description: "Many one-hunk files" },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        changedFiles: paths,
        deletedFiles: [],
        renamedFromByFile: new Map([[paths[0] ?? "", "src/old-name.ts"]]),
        changedLinesByFile: new Map(paths.map((path) => [path, new Set([1])])),
        deletedLinesByFile: new Map(),
        diffText: paths
          .map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`)
          .join("\n"),
      },
    })

    expect(context.changedFiles.map((file) => file.path)).toEqual(paths)
    expect(context.changedFiles[0]?.renamedFrom).toBe("src/old-name.ts")
    expect(
      context.changedFiles.every((file) => file.changedLineRanges === undefined && file.hunkHeaders === undefined),
    ).toBe(true)
    expect(context.diffMetadataTruncated).toBe(true)

    if (padding === 0) expect(JSON.stringify(context.changedFiles).length).toBeLessThan(250_000)
    else expect(JSON.stringify(context.changedFiles).length).toBeGreaterThan(250_000)
  })

  test("includes follow-up review metadata when present", () => {
    const context = buildContext({
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
        deletedFiles: [],
        renamedFromByFile: new Map(),
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

    const context = buildContext({
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
        deletedFiles: [],
        renamedFromByFile: new Map(),
        deletedLinesByFile: new Map(),
      },
    })

    const serialized = JSON.stringify(context)

    expect(serialized).not.toContain(largeLine)
    expect(serialized).not.toContain("--- a/src/huge.ts")
    expect(serialized).not.toContain("+++ b/src/huge.ts")
  })

  test("keeps connected work item text intact when it fits within the generous budget", () => {
    const context = buildContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
        workItemRefs: [{ id: "123" }, { id: "456" }],
      },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        diffText: "",
        changedFiles: [],
        changedLinesByFile: new Map(),
        deletedFiles: [],
        renamedFromByFile: new Map(),
        deletedLinesByFile: new Map(),
      },
      connectedWorkItems: [
        {
          id: 123,
          title: "Bug",
          workItemType: "Bug",
          state: "Active",
          tags: ["one"],
          descriptionMarkdown: "d".repeat(810),
          recentComments: [
            {
              author: "Reviewer",
              createdAt: "2026-03-21T10:00:00.000Z",
              markdown: "c".repeat(410),
            },
          ],
          related: [
            { id: 10, title: "A" },
            { id: 11, title: "B" },
            { id: 12, title: "C" },
            { id: 13, title: "D" },
            { id: 14, title: "E" },
          ],
        },
      ],
    })

    expect(context.connectedWorkItems).toEqual({
      omittedCount: 1,
      items: [
        {
          id: 123,
          title: "Bug",
          workItemType: "Bug",
          state: "Active",
          tags: ["one"],
          descriptionMarkdown: "d".repeat(810),
          related: [
            { id: 10, title: "A" },
            { id: 11, title: "B" },
            { id: 12, title: "C" },
            { id: 13, title: "D" },
          ],
          recentComments: [
            {
              author: "Reviewer",
              createdAt: "2026-03-21T10:00:00.000Z",
              markdown: "c".repeat(410),
            },
          ],
        },
      ],
    })
  })

  test("truncates a single oversize connected work item to fit the aggregate budget", () => {
    const context = buildContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
        workItemRefs: [{ id: "123" }],
      },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        diffText: "",
        changedFiles: [],
        changedLinesByFile: new Map(),
        deletedFiles: [],
        renamedFromByFile: new Map(),
        deletedLinesByFile: new Map(),
      },
      connectedWorkItems: [
        {
          id: 123,
          title: "Bug",
          workItemType: "Bug",
          state: "Active",
          tags: ["one"],
          descriptionMarkdown: "d".repeat(40_000),
          acceptanceCriteriaMarkdown: "a".repeat(8_000),
          reproStepsMarkdown: "r".repeat(8_000),
          recentComments: [
            {
              author: "Reviewer",
              createdAt: "2026-03-21T10:00:00.000Z",
              markdown: "c".repeat(6_000),
            },
          ],
          related: [{ id: 10, title: "A" }],
        },
      ],
    })

    expect(context.connectedWorkItems?.omittedCount).toBe(0)
    expect(context.connectedWorkItems?.items).toHaveLength(1)
    expect(context.connectedWorkItems?.items[0]?.descriptionMarkdown).toContain("[truncated]")
    expect(context.connectedWorkItems?.items[0]?.descriptionMarkdown?.length ?? 0).toBeGreaterThan(800)
    expect(JSON.stringify(context.connectedWorkItems).length).toBeLessThanOrEqual(24_000)
  })

  test("includes eligible pull-request threads in the prompt context", () => {
    const context = buildContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
      },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        diffText: "",
        changedFiles: [],
        changedLinesByFile: new Map(),
        deletedFiles: [],
        renamedFromByFile: new Map(),
        deletedLinesByFile: new Map(),
      },
      existingThreads: [
        makeThread({
          id: 42,
          threadContext: {
            filePath: "/src/example.ts",
            rightFileStart: { line: 10 },
          },
          comments: [
            makeThreadComment({
              id: 420,
              content: "Can we avoid mutating the shared cache here?",
              publishedDate: "2026-03-24T10:00:00.000Z",
            }),
            makeThreadComment({
              id: 421,
              content: "Good catch, I will change it.",
              publishedDate: "2026-03-24T11:00:00.000Z",
              author: { displayName: "Author" },
            }),
          ],
        }),
      ],
    })

    expect(context.pullRequestThreads).toEqual({
      omittedCount: 0,
      items: [
        {
          id: 42,
          status: "active",
          filePath: "/src/example.ts",
          line: 10,
          updatedAt: "2026-03-24T11:00:00.000Z",
          managedThread: false,
          comments: [
            {
              author: "Reviewer",
              publishedAt: "2026-03-24T10:00:00.000Z",
              origin: "human",
              content: "Can we avoid mutating the shared cache here?",
            },
            {
              author: "Author",
              publishedAt: "2026-03-24T11:00:00.000Z",
              origin: "human",
              content: "Good catch, I will change it.",
            },
          ],
        },
      ],
    })
  })

  test("filters out system and non-user discussion threads", () => {
    const context = buildContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
      },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        diffText: "",
        changedFiles: [],
        changedLinesByFile: new Map(),
        deletedFiles: [],
        renamedFromByFile: new Map(),
        deletedLinesByFile: new Map(),
      },
      existingThreads: [
        makeThread({
          id: 1,
          comments: [
            makeThreadComment({
              content: "Policy status has been updated.",
              author: { displayName: "Microsoft.VisualStudio.Services.TFS" },
            }),
          ],
        }),
        makeThread({
          id: 2,
          comments: [
            makeThreadComment({
              content: "This comment should not be included.",
              commentType: "codeChange",
            }),
          ],
        }),
        makeThread({
          id: 3,
          comments: [
            makeThreadComment({
              content: "The fallback path still looks risky.",
              publishedDate: "2026-03-24T12:00:00.000Z",
            }),
          ],
        }),
      ],
    })

    expect(context.pullRequestThreads?.items.map((thread) => thread.id)).toEqual([3])
  })

  test("excludes pure managed threads from the prompt context", () => {
    const context = buildContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
      },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        diffText: "",
        changedFiles: [],
        changedLinesByFile: new Map(),
        deletedFiles: [],
        renamedFromByFile: new Map(),
        deletedLinesByFile: new Map(),
      },
      existingThreads: [makeManagedSummaryThread()],
    })

    expect(context.pullRequestThreads).toBeUndefined()
    expect(context.managedFindings).toBeUndefined()
    expect(context.managedFindingCandidates).toBeUndefined()
  })

  test("keeps managed threads with human replies and strips embedded state payloads", () => {
    const context = buildContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
      },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        diffText: "",
        changedFiles: ["src/example.ts"],
        changedLinesByFile: new Map([["src/example.ts", new Set([2])]]),
        deletedFiles: [],
        renamedFromByFile: new Map(),
        deletedLinesByFile: new Map(),
      },
      existingThreads: [
        makeThread({
          id: 7,
          threadContext: {
            filePath: "src/example.ts",
            rightFileStart: { line: 2 },
          },
          comments: [
            makeThreadComment({
              id: 70,
              content:
                'Finding title\n<!-- open-azdo:{"kind":"finding","fingerprint":"abc","finding":{"severity":"high","confidence":"high","title":"t","body":"Body","filePath":"src/example.ts","line":2}} -->',
              author: { id: BOT_ID, displayName: "Open AZDO" },
              publishedDate: "2026-03-23T09:00:00.000Z",
            }),
            makeThreadComment({
              id: 71,
              content: "This is fixed in the latest patch.",
              author: { displayName: "Author" },
              publishedDate: "2026-03-23T10:00:00.000Z",
            }),
          ],
        }),
      ],
    })

    expect(context.pullRequestThreads).toEqual({
      omittedCount: 0,
      items: [
        {
          id: 7,
          status: "active",
          filePath: "src/example.ts",
          line: 2,
          updatedAt: "2026-03-23T10:00:00.000Z",
          managedThread: true,
          comments: [
            {
              author: "Open AZDO",
              publishedAt: "2026-03-23T09:00:00.000Z",
              origin: "open-azdo",
              content: "Finding title",
            },
            {
              author: "Author",
              publishedAt: "2026-03-23T10:00:00.000Z",
              origin: "human",
              content: "This is fixed in the latest patch.",
            },
          ],
        },
      ],
    })
    expect(context.managedFindings).toEqual({
      omittedCount: 0,
      items: [
        {
          id: 7,
          status: "active",
          resolution: "unresolved",
          filePath: "src/example.ts",
          line: 2,
          updatedAt: "2026-03-23T10:00:00.000Z",
          title: "t",
          severity: "high",
          confidence: "high",
        },
      ],
    })
    expect(context.managedFindingCandidates).toEqual({
      items: [
        {
          id: 7,
          filePath: "src/example.ts",
          line: 2,
          updatedAt: "2026-03-23T10:00:00.000Z",
          title: "t",
          body: "Body",
          severity: "high",
          confidence: "high",
        },
      ],
    })
  })

  test("includes fixed pure managed finding threads in managedFindings while keeping them out of pullRequestThreads", () => {
    const context = buildContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
      },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        diffText: "",
        changedFiles: ["src/legacy.ts"],
        changedLinesByFile: new Map([["src/legacy.ts", new Set([9])]]),
        deletedFiles: [],
        renamedFromByFile: new Map(),
        deletedLinesByFile: new Map(),
      },
      existingThreads: [
        makeThread({
          id: 8,
          status: "fixed",
          threadContext: {
            filePath: "/src/legacy.ts",
            rightFileStart: { line: 9 },
          },
          comments: [
            makeThreadComment({
              id: 80,
              content:
                'Legacy finding\n<!-- open-azdo:{"kind":"finding","fingerprint":"legacy","finding":{"severity":"medium","confidence":"high","title":"Legacy issue","body":"Body","filePath":"src/legacy.ts","line":9}} -->',
              author: { id: BOT_ID, displayName: "Open AZDO" },
              publishedDate: "2026-03-22T10:00:00.000Z",
            }),
          ],
        }),
      ],
    })

    expect(context.pullRequestThreads).toBeUndefined()
    expect(context.managedFindings).toEqual({
      omittedCount: 0,
      items: [
        {
          id: 8,
          status: "fixed",
          resolution: "resolved",
          filePath: "/src/legacy.ts",
          line: 9,
          updatedAt: "2026-03-22T10:00:00.000Z",
          title: "Legacy issue",
          severity: "medium",
          confidence: "high",
        },
      ],
    })
    expect(context.managedFindingCandidates).toBeUndefined()
  })

  test("limits managed finding candidates to active findings that intersect the scoped diff", () => {
    const completeBody = "Evidence for an eligible finding. ".repeat(1_000)
    const completeSuggestion = "return correctValue\n".repeat(1_000)

    const context = buildContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
      },
      reviewMode: "follow-up",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "prev",
        headRef: "HEAD",
        diffText: "",
        changedFiles: ["src/example.ts"],
        changedLinesByFile: new Map([["src/example.ts", new Set([5])]]),
        deletedFiles: [],
        renamedFromByFile: new Map(),
        deletedLinesByFile: new Map(),
      },
      existingThreads: [
        makeManagedFindingThread(
          makeReviewFinding({ title: "Large candidate", body: completeBody, suggestion: completeSuggestion, line: 5 }),
          24,
        ),
        makeThread({
          id: 21,
          threadContext: {
            filePath: "/src/example.ts",
            rightFileStart: { line: 5 },
          },
          comments: [
            makeThreadComment({
              id: 210,
              content:
                'Current finding\n<!-- open-azdo:{"kind":"finding","fingerprint":"current","finding":{"severity":"high","confidence":"high","title":"Current","body":"Body","filePath":"src/example.ts","line":5}} -->',
              author: { id: BOT_ID, displayName: "Open AZDO" },
            }),
          ],
        }),
        makeThread({
          id: 22,
          threadContext: {
            filePath: "/src/other.ts",
            rightFileStart: { line: 20 },
          },
          comments: [
            makeThreadComment({
              id: 220,
              content:
                'Outside scope\n<!-- open-azdo:{"kind":"finding","fingerprint":"outside","finding":{"severity":"medium","confidence":"high","title":"Outside","body":"Body","filePath":"src/other.ts","line":20}} -->',
              author: { id: BOT_ID, displayName: "Open AZDO" },
            }),
          ],
        }),
        makeThread({
          id: 23,
          status: "fixed",
          threadContext: {
            filePath: "/src/example.ts",
            rightFileStart: { line: 5 },
          },
          comments: [
            makeThreadComment({
              id: 230,
              content:
                'Resolved\n<!-- open-azdo:{"kind":"finding","fingerprint":"resolved","finding":{"severity":"medium","confidence":"high","title":"Resolved","body":"Body","filePath":"src/example.ts","line":5}} -->',
              author: { id: BOT_ID, displayName: "Open AZDO" },
            }),
          ],
        }),
      ],
    })

    expect(context.managedFindingCandidates).toEqual({
      items: [
        {
          id: 21,
          filePath: "src/example.ts",
          line: 5,
          updatedAt: "2026-03-21T10:00:00.000Z",
          title: "Current",
          body: "Body",
          severity: "high",
          confidence: "high",
        },
        {
          id: 24,
          filePath: "src/example.ts",
          line: 5,
          endLine: 5,
          title: "Large candidate",
          body: completeBody,
          suggestion: completeSuggestion,
          severity: "high",
          confidence: "high",
        },
      ],
    })
  })

  test("drops the oldest eligible threads when the thread context budget is exceeded", () => {
    const context = buildContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
      },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        diffText: "",
        changedFiles: [],
        changedLinesByFile: new Map(),
        deletedFiles: [],
        renamedFromByFile: new Map(),
        deletedLinesByFile: new Map(),
      },
      existingThreads: [
        makeThread({
          id: 1,
          comments: [
            makeThreadComment({
              content: "a".repeat(9_000),
              publishedDate: "2026-03-21T10:00:00.000Z",
            }),
          ],
        }),
        makeThread({
          id: 2,
          comments: [
            makeThreadComment({
              content: "b".repeat(9_000),
              publishedDate: "2026-03-22T10:00:00.000Z",
            }),
          ],
        }),
        makeThread({
          id: 3,
          comments: [
            makeThreadComment({
              content: "c".repeat(9_000),
              publishedDate: "2026-03-23T10:00:00.000Z",
            }),
          ],
        }),
      ],
    })

    expect(context.pullRequestThreads?.omittedCount).toBe(1)
    expect(context.pullRequestThreads?.items.map((thread) => thread.id)).toEqual([3, 2])
  })

  test("truncates a single oversize thread only enough to fit the thread budget", () => {
    const context = buildContext({
      metadata: {
        title: "Feature PR",
        description: "Adds a new export",
      },
      reviewMode: "full",
      pullRequestBaseRef: "base",
      gitDiff: {
        baseRef: "base",
        headRef: "HEAD",
        diffText: "",
        changedFiles: [],
        changedLinesByFile: new Map(),
        deletedFiles: [],
        renamedFromByFile: new Map(),
        deletedLinesByFile: new Map(),
      },
      existingThreads: [
        makeThread({
          id: 9,
          comments: [
            makeThreadComment({
              content: "x".repeat(40_000),
              publishedDate: "2026-03-23T10:00:00.000Z",
            }),
          ],
        }),
      ],
    })

    expect(context.pullRequestThreads?.omittedCount).toBe(0)
    expect(context.pullRequestThreads?.items).toHaveLength(1)
    expect(context.pullRequestThreads?.items[0]?.comments[0]?.content).toContain("[truncated]")
    expect(context.pullRequestThreads?.items[0]?.comments[0]?.content.length ?? 0).toBeGreaterThan(2_000)
    expect(JSON.stringify(context.pullRequestThreads).length).toBeLessThanOrEqual(24_000)
  })
})
