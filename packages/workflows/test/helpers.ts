import { Effect, Logger, Redacted } from "effect"

import { createAzureContext, type AzureDevOpsClient, type AzureDevOpsClientShape } from "@open-azdo/azdo/client"
import type { ExistingThread } from "@open-azdo/azdo/schemas"
import {
  encodeMarker,
  fingerprintFinding,
  type NormalizedReviewResult,
  type ReviewFinding,
} from "@open-azdo/workflows/review"

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

export const makeManagedSummaryThread = (): ExistingThread => ({
  id: 1,
  status: 1,
  comments: [
    {
      id: 10,
      content: `summary\n${encodeMarker({ kind: "summary", fingerprint: "summary" })}`,
    },
  ],
})

export const makeManagedFindingThread = (finding: ReviewFinding, threadId = 2): ExistingThread => ({
  id: threadId,
  status: 1,
  comments: [
    {
      id: threadId * 10,
      content: `finding\n${encodeMarker({ kind: "finding", fingerprint: fingerprintFinding(finding) })}`,
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
    }),
  listThreads: () => Effect.succeed([]),
  updateThreadStatus: () => Effect.void,
  updateComment: () => Effect.void,
  createThread: () => Effect.void,
  ...overrides,
})

export const systemToken = Redacted.make("system-token")
