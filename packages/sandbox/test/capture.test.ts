import { describe, expect, test } from "bun:test"
import { Schema } from "effect"

import { SandboxCaptureSchema, projectPreviewThreads } from "../src/capture"

const baseCapture = {
  schemaVersion: 1 as const,
  capturedAt: "2026-03-22T10:30:00.000Z",
  workspaceMode: "temporary" as const,
  target: {
    organization: "acme",
    project: "project",
    collectionUrl: "https://dev.azure.com/acme",
    repositoryId: "repo-1",
    pullRequestId: 42,
  },
  metadata: {
    title: "Feature PR",
    description: "Adds a new export",
    sourceRefName: "refs/heads/feature",
    targetRefName: "refs/heads/main",
    createdByDisplayName: "Annie Case",
    repository: {
      id: "repo-1",
      name: "open-azdo",
      remoteUrl: "https://dev.azure.com/acme/project/_git/repo-1",
      webUrl: "https://dev.azure.com/acme/project/_git/repo-1",
    },
    sourceCommitId: "abc123",
    workItemRefs: [],
  },
  workItems: [],
  baselineThreads: [
    {
      id: 1,
      status: 1,
      comments: [
        {
          id: 10,
          content: "Original summary",
        },
      ],
    },
  ],
  diff: {
    baseRef: "base-sha",
    headRef: "head-sha",
    diffText: "diff --git a/src/example.ts b/src/example.ts",
    files: [
      {
        path: "src/example.ts",
        patch: "diff --git a/src/example.ts b/src/example.ts",
        changedLineRanges: [
          {
            start: 2,
            end: 4,
          },
        ],
      },
    ],
  },
  review: {
    mode: "full" as const,
    prompt: "Review this pull request.",
    resultSource: "structured" as const,
    openCodeResult: {
      response: '{"summary":"Summary","verdict":"concerns"}',
      structured: {
        summary: "Summary",
        verdict: "concerns",
      },
    },
    result: {
      summary: "Summary",
      verdict: "concerns" as const,
      findings: [
        {
          severity: "high" as const,
          confidence: "high" as const,
          title: "Finding title",
          body: "Finding body",
          filePath: "src/example.ts",
          line: 2,
        },
      ],
      inlineFindings: [
        {
          severity: "high" as const,
          confidence: "high" as const,
          title: "Finding title",
          body: "Finding body",
          filePath: "src/example.ts",
          line: 2,
        },
      ],
      summaryOnlyFindings: [],
      unmappedNotes: [],
    },
    summaryState: {
      schemaVersion: 2 as const,
      reviewedCommit: "head-sha",
      pullRequestBaseRef: "base-sha",
      verdict: "concerns" as const,
      findingsCount: 1,
      inlineFindingsCount: 1,
      unmappedNotesCount: 0,
      severityCounts: {
        low: 0,
        medium: 0,
        high: 1,
        critical: 0,
      },
      reviewHistory: [],
    },
    summaryContent: "Summary content",
    actions: [
      {
        type: "upsert-finding" as const,
        content: "Updated finding body",
        existingThreadId: 1,
        commentId: 10,
        finding: {
          severity: "high" as const,
          confidence: "high" as const,
          title: "Finding title",
          body: "Finding body",
          filePath: "src/example.ts",
          line: 2,
        },
      },
      {
        type: "close-thread" as const,
        existingThreadId: 9,
      },
    ],
    previewThreads: [
      {
        id: 1,
        status: 1,
        comments: [
          {
            id: 10,
            content: "Updated finding body",
          },
        ],
      },
    ],
  },
}

describe("sandbox capture", () => {
  test("decodes a complete capture artifact", () => {
    const decoded = Schema.decodeUnknownSync(SandboxCaptureSchema)(baseCapture)

    expect(decoded.target.pullRequestId).toBe(42)
    expect(decoded.review.previewThreads.length).toBeGreaterThanOrEqual(decoded.baselineThreads.length)
  })

  test("projects preview threads from thread actions", () => {
    const projected = projectPreviewThreads(baseCapture.baselineThreads, baseCapture.review.actions)

    expect(projected.find((thread) => thread.id === 1)?.comments.at(-1)?.content).toContain("Updated finding body")
    expect(projected.find((thread) => thread.id === 9)?.status).toBeUndefined()
  })
})
