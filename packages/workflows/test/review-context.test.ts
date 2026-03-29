import { describe, expect, test } from "bun:test"

import type { ExistingThread } from "@open-azdo/azdo/schemas"
import { type PullRequestDiff } from "@open-azdo/core/git"
import { buildReviewContext } from "../src/review/ReviewContext"

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

  test("keeps connected work item text intact when it fits within the generous budget", () => {
    const context = buildReviewContext({
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
    const context = buildReviewContext({
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
  })

  test("includes eligible pull-request threads in the prompt context", () => {
    const context = buildReviewContext({
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
    const context = buildReviewContext({
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
    const context = buildReviewContext({
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
        deletedLinesByFile: new Map(),
      },
      existingThreads: [
        makeThread({
          comments: [
            makeThreadComment({
              content: 'Summary\n<!-- open-azdo-review:{"reviewedCommit":"abc"} -->',
              author: { displayName: "Open AZDO" },
            }),
          ],
        }),
      ],
    })

    expect(context.pullRequestThreads).toBeUndefined()
    expect(context.managedFindings).toBeUndefined()
  })

  test("keeps managed threads with human replies and strips embedded state payloads", () => {
    const context = buildReviewContext({
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
              author: { displayName: "Open AZDO" },
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
  })

  test("includes fixed pure managed finding threads in managedFindings while keeping them out of pullRequestThreads", () => {
    const context = buildReviewContext({
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
              author: { displayName: "Open AZDO" },
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
  })

  test("drops the oldest eligible threads when the thread context budget is exceeded", () => {
    const context = buildReviewContext({
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
    const context = buildReviewContext({
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
  })
})
