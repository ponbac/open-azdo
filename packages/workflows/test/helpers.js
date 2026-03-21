import { Effect, Logger, Redacted } from "effect"
import { createAzureContext } from "@open-azdo/azdo/client"
import {
  buildInlineComment,
  buildManagedReviewState,
  buildSummaryComment,
  findManagedSummaryThread,
  fingerprintFinding,
} from "../src/review/ThreadReconciliation"
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
export const withSilentLogs = (effect) => effect.pipe(Effect.provide(SilentLoggerLayer))
export const makeReviewFinding = (overrides = {}) => ({
  severity: "high",
  confidence: "high",
  title: "Finding title",
  body: "Finding body",
  filePath: "src/example.ts",
  line: 2,
  ...overrides,
})
export const makeNormalizedReviewResult = (findings, inlineFindings = findings) => ({
  summary: "Summary",
  verdict: "concerns",
  findings: [...findings],
  inlineFindings: [...inlineFindings],
  summaryOnlyFindings: findings.filter((finding) => !inlineFindings.includes(finding)),
  unmappedNotes: [],
})
export const makeManagedReviewState = (overrides = {}) => ({
  ...buildManagedReviewState({
    reviewedCommit: "reviewed-sha",
    pullRequestBaseRef: "base-sha",
    reviewResult: makeNormalizedReviewResult([makeReviewFinding()]),
  }),
  ...overrides,
})
export const makeSummarySnapshot = (overrides = {}, persistedState = makeManagedReviewState()) => ({
  verdict: persistedState.verdict,
  summary: "Summary",
  unmappedNotes: [],
  severityCounts: persistedState.severityCounts,
  persistedState,
  ...overrides,
})
export const makeManagedSummaryThread = (reviewState = makeManagedReviewState(), threadId = 1) => ({
  id: threadId,
  status: 1,
  comments: [
    {
      id: threadId * 10,
      content: buildSummaryComment(makeSummarySnapshot({}, reviewState)),
    },
  ],
})
export const makeManagedFindingThread = (finding, threadId = 2, status = 1) => ({
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
export const makeAzureDevOpsClient = (overrides = {}) => ({
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
export const extractManagedSummaryState = (thread) => findManagedSummaryThread([thread])?.reviewState
export const findingFingerprint = (finding) => fingerprintFinding(finding)
