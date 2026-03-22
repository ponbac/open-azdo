import { Effect, Logger, Redacted } from "effect"

import { createAzureContext, type AzureDevOpsClient, type AzureDevOpsClientShape } from "@open-azdo/azdo/client"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import {
  buildInlineComment,
  buildManagedReviewState,
  buildSummaryComment,
  findManagedSummaryThread,
  fingerprintFinding,
  type ManagedReviewState,
  type ReviewHistoryEntry,
} from "../src/review/ThreadReconciliation"
import type { NormalizedReviewResult, ReviewFinding } from "../src/review/ReviewOutput"

export const makeAzureContext = () =>
  createAzureContext({
    organization: "acme",
    project: "project",
    collectionUrl: "https://dev.azure.com/acme",
    repositoryId: "repo-1",
    pullRequestId: 42,
    buildId: "99",
    buildNumber: "99",
    targetBranch: "refs/heads/main",
  })

const SilentLoggerLayer = Logger.layer([Logger.make(() => undefined)], {
  mergeWithExisting: false,
})

export const withSilentLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SilentLoggerLayer))

export const makeReviewFinding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  severity: "high",
  confidence: "high",
  title: "Finding title",
  body: "Finding body",
  filePath: "src/example.ts",
  line: 2,
  ...overrides,
})

export const makeNormalizedReviewResult = (
  findings: ReadonlyArray<ReviewFinding>,
  inlineFindings: ReadonlyArray<ReviewFinding> = findings,
): NormalizedReviewResult => ({
  summary: "Summary",
  verdict: "concerns",
  findings: [...findings],
  inlineFindings: [...inlineFindings],
  summaryOnlyFindings: findings.filter((finding) => !inlineFindings.includes(finding)),
  unmappedNotes: [],
})

export const makeManagedReviewState = (overrides: Partial<ManagedReviewState> = {}): ManagedReviewState =>
  ({
    ...buildManagedReviewState({
      reviewedCommit: "reviewed-sha",
      pullRequestBaseRef: "base-sha",
      reviewResult: makeNormalizedReviewResult([makeReviewFinding()]),
    }),
    ...overrides,
  }) satisfies ManagedReviewState

export const makeReviewHistoryEntry = (overrides: Partial<ReviewHistoryEntry> = {}): ReviewHistoryEntry => ({
  reviewedCommit: "reviewed-sha",
  reviewedAt: "2026-03-20T15:30:00.000Z",
  reviewMode: "full",
  model: "openai/gpt-5.4",
  buildNumber: "99",
  buildId: "99",
  buildLink: "https://dev.azure.com/acme/project/_build/results?buildId=99",
  costUsd: 0.1234,
  tokens: {
    input: 1200,
    output: 345,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  ...overrides,
})

export const makeSummarySnapshot = (
  overrides: Record<string, unknown> = {},
  persistedState: ManagedReviewState = makeManagedReviewState(),
) => ({
  verdict: persistedState.verdict,
  summary: "Summary",
  unmappedNotes: [],
  severityCounts: persistedState.severityCounts,
  persistedState,
  ...overrides,
})

export const makeManagedSummaryThread = (
  reviewState: ManagedReviewState = makeManagedReviewState(),
  threadId = 1,
): ExistingThread => ({
  id: threadId,
  status: 1,
  comments: [
    {
      id: threadId * 10,
      content: buildSummaryComment(makeSummarySnapshot({}, reviewState)),
    },
  ],
})

export const makeManagedFindingThread = (finding: ReviewFinding, threadId = 2, status: 1 | 2 = 1): ExistingThread => ({
  id: threadId,
  status,
  comments: [
    {
      id: threadId * 10,
      content: buildInlineComment(finding),
    },
  ],
  threadContext: {
    filePath: `/${finding.filePath}`,
    rightFileStart: { line: finding.line },
    rightFileEnd: { line: finding.endLine ?? finding.line },
  },
})

export const makeAzureDevOpsClient = (
  overrides: Partial<AzureDevOpsClientShape> = {},
): AzureDevOpsClient["Service"] => ({
  getPullRequestMetadata: () =>
    Effect.succeed({
      title: "Feature PR",
      description: "Adds a new export",
      workItemRefs: [],
    }),
  getPullRequestWorkItems: () => Effect.succeed([]),
  listThreads: () => Effect.succeed([]),
  updateThreadStatus: () => Effect.void,
  updateComment: () => Effect.void,
  createThread: () => Effect.void,
  ...overrides,
})

export const systemToken = Redacted.make("system-token")

export const extractManagedSummaryState = (thread: ExistingThread) => findManagedSummaryThread([thread])?.reviewState

export const findingFingerprint = (finding: ReviewFinding) => fingerprintFinding(finding)
