import { projectPreviewThreads, type SandboxCapture } from "@open-azdo/sandbox/capture"

const actions: SandboxCapture["review"]["actions"] = [
  {
    type: "upsert-summary",
    content: [
      "## open-azdo review",
      "",
      "Verdict: **concerns**",
      "",
      "- 1 high-severity finding is ready to publish.",
      "- 1 existing stale thread would be closed.",
    ].join("\n"),
    existingThreadId: 101,
    commentId: 1001,
  },
  {
    type: "upsert-finding",
    content: [
      "### Shared client cache is mutated during render",
      "",
      "The new code mutates shared state from a render path. That can produce duplicate comments in follow-up reviews.",
    ].join("\n"),
    existingThreadId: 202,
    commentId: 2001,
    finding: {
      severity: "high",
      confidence: "high",
      title: "Shared client cache is mutated during render",
      body: "Mutating shared state from render can duplicate or reorder PR comments in follow-up runs.",
      filePath: "src/review/ReviewPanel.tsx",
      line: 34,
      endLine: 42,
      suggestion: "Move the cache write into an Effect-run update path outside of render.",
    },
  },
  {
    type: "close-thread",
    existingThreadId: 303,
  },
]

const baselineThreads: SandboxCapture["baselineThreads"] = [
  {
    id: 101,
    status: 1,
    comments: [
      {
        id: 1001,
        content: "## open-azdo review\n\nVerdict: **pass**",
        author: {
          displayName: "open-azdo",
        },
        publishedDate: "2026-03-20T09:15:00.000Z",
        isDeleted: false,
        commentType: 1,
      },
    ],
  },
  {
    id: 202,
    status: 1,
    comments: [
      {
        id: 2001,
        content: "Earlier concern about thread ordering.",
        author: {
          displayName: "open-azdo",
        },
        publishedDate: "2026-03-20T09:15:00.000Z",
        isDeleted: false,
        commentType: 1,
      },
    ],
    threadContext: {
      filePath: "/src/review/ReviewPanel.tsx",
      rightFileStart: {
        line: 34,
        offset: 1,
      },
      rightFileEnd: {
        line: 42,
        offset: 1,
      },
    },
  },
  {
    id: 303,
    status: 1,
    comments: [
      {
        id: 3001,
        content: "Stale note on an already-removed branch check.",
        author: {
          displayName: "Reviewer Bot",
        },
        publishedDate: "2026-03-19T18:00:00.000Z",
        isDeleted: false,
        commentType: 1,
      },
    ],
    threadContext: {
      filePath: "/src/review/LegacyGate.ts",
      rightFileStart: {
        line: 8,
        offset: 1,
      },
      rightFileEnd: {
        line: 10,
        offset: 1,
      },
    },
  },
]

export const demoCapture: SandboxCapture = {
  schemaVersion: 2,
  capturedAt: "2026-03-22T10:30:00.000Z",
  workspaceMode: "temporary",
  target: {
    organization: "acme",
    project: "platform",
    collectionUrl: "https://dev.azure.com/acme",
    repositoryId: "repo-1",
    pullRequestId: 481,
  },
  metadata: {
    pullRequestId: 481,
    title: "Preview the new managed review flow",
    description: "Adds sandbox capture output and improves follow-up review state handling.",
    url: "https://dev.azure.com/acme/platform/_git/repo-1/pullrequest/481",
    sourceRefName: "refs/heads/feature/sandbox-preview",
    targetRefName: "refs/heads/main",
    createdByDisplayName: "Annie Case",
    repository: {
      id: "repo-1",
      name: "open-azdo",
      remoteUrl: "https://dev.azure.com/acme/platform/_git/repo-1",
      webUrl: "https://dev.azure.com/acme/platform/_git/repo-1",
    },
    sourceCommitId: "83f6d4caa7419999d8974cb0350c5ad7b6206c6b",
    workItemRefs: [
      {
        id: "913",
        url: "https://dev.azure.com/acme/platform/_apis/wit/workItems/913",
      },
      {
        id: "944",
        url: "https://dev.azure.com/acme/platform/_apis/wit/workItems/944",
      },
    ],
  },
  workItems: [
    {
      id: 913,
      title: "Allow local validation against a real PR",
      workItemType: "Feature",
      state: "Active",
      priority: 1,
      assignedTo: "Annie Case",
      iterationPath: "Platform\\Q1",
      areaPath: "Platform\\Developer Experience",
      tags: ["sandbox", "validation", "pr-review"],
      descriptionMarkdown: "Agents need a safe way to validate review output against a real Azure DevOps PR.",
      acceptanceCriteriaMarkdown: "- Capture runs stay read-only.\n- Output can be replayed locally.",
      related: [
        {
          id: 944,
          title: "Fake PR sandbox shell",
        },
      ],
      recentComments: [
        {
          author: "Product Owner",
          createdAt: "2026-03-21T13:15:00.000Z",
          markdown: "Please make sure the local preview feels close to the final AZDO experience.",
        },
      ],
    },
    {
      id: 944,
      title: "Ship a local sandbox app for captures",
      workItemType: "User Story",
      state: "Committed",
      priority: 2,
      assignedTo: "Pontus Bac",
      iterationPath: "Platform\\Q1",
      areaPath: "Platform\\Developer Experience",
      tags: ["ui", "sandbox"],
      reproStepsMarkdown:
        "1. Generate a capture.\n2. Import it in the sandbox app.\n3. Compare before and after thread states.",
      related: [],
      recentComments: [],
    },
  ],
  baselineThreads,
  diff: {
    baseRef: "9f89ac4b69f90e2e2a57e8dfc32b28a4c68c0f10",
    headRef: "83f6d4caa7419999d8974cb0350c5ad7b6206c6b",
    diffText: [
      "diff --git a/src/review/ReviewPanel.tsx b/src/review/ReviewPanel.tsx",
      "index 91c5f12..ec5bb78 100644",
      "--- a/src/review/ReviewPanel.tsx",
      "+++ b/src/review/ReviewPanel.tsx",
      "@@ -30,7 +30,15 @@ export function ReviewPanel() {",
      "-  sharedThreadCache[path] = current",
      "+  const nextComment = buildComment(current)",
      "+",
      "+  if (sharedThreadCache[path] !== nextComment) {",
      "+    sharedThreadCache[path] = nextComment",
      "+  }",
      "+",
      "+  const renderState = {",
      "+    nextComment,",
      "+  }",
      " ",
      "   return <PanelBody state={renderState} />",
      " }",
      "",
      "diff --git a/src/review/LegacyGate.ts b/src/review/LegacyGate.ts",
      "deleted file mode 100644",
      "index 88c55f1..0000000",
      "--- a/src/review/LegacyGate.ts",
      "+++ /dev/null",
      "@@ -1,10 +0,0 @@",
      '-export const legacyGate = "remove me"',
      "-if (process.env.CI) {",
      "-  console.log(legacyGate)",
      "-}",
    ].join("\n"),
    files: [
      {
        path: "src/review/ReviewPanel.tsx",
        patch: [
          "diff --git a/src/review/ReviewPanel.tsx b/src/review/ReviewPanel.tsx",
          "index 91c5f12..ec5bb78 100644",
          "--- a/src/review/ReviewPanel.tsx",
          "+++ b/src/review/ReviewPanel.tsx",
          "@@ -30,7 +30,15 @@ export function ReviewPanel() {",
          "-  sharedThreadCache[path] = current",
          "+  const nextComment = buildComment(current)",
          "+",
          "+  if (sharedThreadCache[path] !== nextComment) {",
          "+    sharedThreadCache[path] = nextComment",
          "+  }",
          "+",
          "+  const renderState = {",
          "+    nextComment,",
          "+  }",
          " ",
          "   return <PanelBody state={renderState} />",
          " }",
        ].join("\n"),
        changedLineRanges: [
          {
            start: 31,
            end: 38,
          },
        ],
      },
      {
        path: "src/review/LegacyGate.ts",
        patch: [
          "diff --git a/src/review/LegacyGate.ts b/src/review/LegacyGate.ts",
          "deleted file mode 100644",
          "index 88c55f1..0000000",
          "--- a/src/review/LegacyGate.ts",
          "+++ /dev/null",
          "@@ -1,10 +0,0 @@",
          '-export const legacyGate = "remove me"',
          "-if (process.env.CI) {",
          "-  console.log(legacyGate)",
          "-}",
        ].join("\n"),
        changedLineRanges: [
          {
            start: 1,
            end: 10,
          },
        ],
      },
    ],
  },
  review: {
    mode: "full",
    prompt: [
      "Review this Azure DevOps pull request.",
      "",
      "Prioritize correctness, comment duplication risk, and follow-up review stability.",
      "",
      "Pull request context:",
      JSON.stringify(
        {
          pullRequest: {
            title: "Preview the new managed review flow",
            description: "Adds sandbox capture output and improves follow-up review state handling.",
          },
          reviewMode: "full",
          pullRequestBaseRef: "9f89ac4b69f90e2e2a57e8dfc32b28a4c68c0f10",
          baseRef: "9f89ac4b69f90e2e2a57e8dfc32b28a4c68c0f10",
          headRef: "83f6d4caa7419999d8974cb0350c5ad7b6206c6b",
          changedFiles: [
            {
              path: "src/review/ReviewPanel.tsx",
              changedLineRanges: [{ start: 31, end: 38 }],
              hunkHeaders: ["@@ -30,7 +30,15 @@ export function ReviewPanel()"],
            },
            {
              path: "src/review/LegacyGate.ts",
              changedLineRanges: [{ start: 1, end: 10 }],
              hunkHeaders: ["@@ -1,10 +0,0 @@"],
            },
          ],
          pullRequestThreads: {
            omittedCount: 1,
            items: [
              {
                id: 303,
                status: "active",
                filePath: "/src/review/LegacyGate.ts",
                line: 8,
                updatedAt: "2026-03-19T18:00:00.000Z",
                managedThread: false,
                comments: [
                  {
                    author: "Reviewer Bot",
                    publishedAt: "2026-03-19T18:00:00.000Z",
                    origin: "human" as const,
                    content: "Stale note on an already-removed branch check.",
                  },
                ],
              },
              {
                id: 404,
                status: "active",
                filePath: "/src/review/ReviewPanel.tsx",
                line: 30,
                updatedAt: "2026-03-21T14:22:00.000Z",
                managedThread: false,
                comments: [
                  {
                    author: "Annie Case",
                    publishedAt: "2026-03-21T14:22:00.000Z",
                    origin: "human" as const,
                    content:
                      "We should guard against concurrent mutations here. The shared cache is not thread-safe in SSR scenarios.",
                  },
                  {
                    author: "Pontus Bac",
                    publishedAt: "2026-03-21T15:10:00.000Z",
                    origin: "human" as const,
                    content: "Good call. I'll move it into the Effect pipeline so it runs outside of render.",
                  },
                ],
              },
            ],
          },
          connectedWorkItems: {
            omittedCount: 0,
            items: [
              {
                id: 913,
                title: "Allow local validation against a real PR",
                workItemType: "Feature",
                state: "Active",
                priority: 1,
                assignedTo: "Annie Case",
                iterationPath: "Platform\\Q1",
                areaPath: "Platform\\Developer Experience",
                tags: ["sandbox", "validation", "pr-review"],
                descriptionMarkdown: "Agents need a safe way to validate review output against a real Azure DevOps PR.",
                acceptanceCriteriaMarkdown: "- Capture runs stay read-only.\n- Output can be replayed locally.",
                related: [{ id: 944, title: "Fake PR sandbox shell" }],
                recentComments: [
                  {
                    author: "Product Owner",
                    createdAt: "2026-03-21T13:15:00.000Z",
                    markdown: "Please make sure the local preview feels close to the final AZDO experience.",
                  },
                ],
              },
              {
                id: 944,
                title: "Ship a local sandbox app for captures",
                workItemType: "User Story",
                state: "Committed",
                priority: 2,
                assignedTo: "Pontus Bac",
                iterationPath: "Platform\\Q1",
                areaPath: "Platform\\Developer Experience",
                tags: ["ui", "sandbox"],
                related: [],
                recentComments: [],
              },
            ],
          },
        },
        null,
        2,
      ),
    ].join("\n"),
    resultSource: "structured",
    openCodeResult: {
      response: JSON.stringify({
        verdict: "concerns",
      }),
      structured: {
        verdict: "concerns",
      },
      sessionId: "ses_demo",
      usage: {
        costUsd: 0.0723,
        tokens: {
          input: 2350,
          output: 411,
          reasoning: 120,
          cacheRead: 80,
          cacheWrite: 0,
        },
      },
    },
    result: {
      verdict: "concerns",
      findings: [
        {
          severity: "high",
          confidence: "high",
          title: "Shared client cache is mutated during render",
          body: "Mutating shared state from render can duplicate or reorder PR comments in follow-up runs.",
          filePath: "src/review/ReviewPanel.tsx",
          line: 34,
          endLine: 42,
          suggestion: "Move the cache write into an Effect-run update path outside of render.",
        },
      ],
      inlineFindings: [
        {
          severity: "high",
          confidence: "high",
          title: "Shared client cache is mutated during render",
          body: "Mutating shared state from render can duplicate or reorder PR comments in follow-up runs.",
          filePath: "src/review/ReviewPanel.tsx",
          line: 34,
          endLine: 42,
          suggestion: "Move the cache write into an Effect-run update path outside of render.",
        },
      ],
      summaryOnlyFindings: [],
      unmappedNotes: [],
    },
    summaryPass: {
      prompt: [
        "You are writing the human-facing summary for an Azure DevOps pull-request review.",
        "",
        "Structured review subjects:",
        '[{"id":"inline-finding-1","kind":"inline-finding","title":"Shared client cache is mutated during render","body":"Mutating shared state from render can duplicate or reorder PR comments in follow-up runs.","severity":"high","confidence":"high","filePath":"src/review/ReviewPanel.tsx","line":34}]',
      ].join("\n"),
      resultSource: "structured",
      openCodeResult: {
        response: JSON.stringify({
          highlights: [
            {
              subjectIds: ["inline-finding-1"],
              text: "Rendering mutates shared client state, which can duplicate or reorder PR comments on later runs.",
            },
          ],
        }),
        structured: {
          highlights: [
            {
              subjectIds: ["inline-finding-1"],
              text: "Rendering mutates shared client state, which can duplicate or reorder PR comments on later runs.",
            },
          ],
        },
        sessionId: "ses_demo_summary",
        usage: {
          costUsd: 0.0182,
          tokens: {
            input: 420,
            output: 96,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      },
      result: {
        highlights: [
          {
            subjectIds: ["inline-finding-1"],
            text: "Rendering mutates shared client state, which can duplicate or reorder PR comments on later runs.",
          },
        ],
      },
      fallbackUsed: false,
      subjects: [
        {
          id: "inline-finding-1",
          kind: "inline-finding",
          title: "Shared client cache is mutated during render",
          body: "Mutating shared state from render can duplicate or reorder PR comments in follow-up runs.",
          severity: "high",
          confidence: "high",
          filePath: "src/review/ReviewPanel.tsx",
          line: 34,
        },
      ],
    },
    summaryState: {
      schemaVersion: 2,
      reviewedCommit: "83f6d4caa7419999d8974cb0350c5ad7b6206c6b",
      pullRequestBaseRef: "9f89ac4b69f90e2e2a57e8dfc32b28a4c68c0f10",
      verdict: "concerns",
      severityCounts: {
        low: 0,
        medium: 0,
        high: 1,
        critical: 0,
      },
      findingsCount: 1,
      inlineFindingsCount: 1,
      unmappedNotesCount: 0,
      reviewHistory: [
        {
          reviewedCommit: "9f89ac4b69f90e2e2a57e8dfc32b28a4c68c0f10",
          reviewedAt: "2026-03-20T09:15:00.000Z",
          reviewMode: "full",
          model: "openai/gpt-5.4-mini",
          buildNumber: "418",
          buildId: "418",
          buildLink: "https://dev.azure.com/acme/platform/_build/results?buildId=418",
          costUsd: 0.0314,
          tokens: {
            input: 1200,
            output: 220,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
        {
          reviewedCommit: "83f6d4caa7419999d8974cb0350c5ad7b6206c6b",
          reviewedAt: "2026-03-22T10:30:00.000Z",
          reviewMode: "full",
          model: "openai/gpt-5.4",
          buildNumber: "422",
          buildId: "422",
          buildLink: "https://dev.azure.com/acme/platform/_build/results?buildId=422",
          costUsd: 0.0905,
          tokens: {
            input: 2770,
            output: 507,
            reasoning: 120,
            cacheRead: 80,
            cacheWrite: 0,
          },
        },
      ],
    },
    summaryContent: "## open-azdo review\n\nVerdict: **concerns**\n\n1 high-severity finding remains open.",
    actions,
    previewThreads: projectPreviewThreads(baselineThreads, actions),
  },
}
