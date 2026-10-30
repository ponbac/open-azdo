import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { Effect, type Types } from "effect"

import { AzureDevOpsClient, createAzureContext } from "@open-azdo/azdo/client"
import { withoutAzureDevOpsCredentials, type OpenCodeRunResult } from "@open-azdo/core/opencode"
import { compressChangedLines, splitDiffByFile } from "@open-azdo/core/git"
import { planReviewWorkflow, type PlannedReviewWorkflow, type ReviewWorkflowConfig } from "@open-azdo/workflows/review"
import {
  decodeSandboxCapture,
  projectPreviewThreads,
  toSandboxPreviewAction,
  type SandboxCapture,
} from "@open-azdo/sandbox/capture"

import { SandboxCaptureConfig } from "./SandboxCaptureConfig"
import { prepareSandboxWorkspace } from "./live/Workspace"

/** Project runtime results into the capture schema, omitting absent optional fields before persistence. */
const captureOpenCodeResult = (result: OpenCodeRunResult) => {
  const captured: Types.Mutable<NonNullable<SandboxCapture["review"]["openCodeResult"]>> = {
    response: result.response,
  }

  if (result.structured !== undefined) {
    captured.structured = result.structured
  }

  if (result.modelError !== undefined) {
    captured.modelError = result.modelError
  }

  if (result.sessionId !== undefined) {
    captured.sessionId = result.sessionId
  }

  if (result.usage !== undefined) {
    const usage: Types.Mutable<NonNullable<typeof captured.usage>> = {}

    if (result.usage.costUsd !== undefined) {
      usage.costUsd = result.usage.costUsd
    }

    if (result.usage.tokens !== undefined) {
      usage.tokens = result.usage.tokens
    }

    captured.usage = usage
  }

  return captured
}

/** Build the persisted preview from the planned review without publishing Azure DevOps mutations. */
const buildSandboxCapture = ({
  config,
  planned,
  workspaceMode,
}: {
  readonly config: SandboxCaptureConfig["Service"]
  readonly planned: PlannedReviewWorkflow
  readonly workspaceMode: "provided" | "temporary"
}) => {
  const actions = planned.actions.map(toSandboxPreviewAction)

  const summaryPass: Types.Mutable<SandboxCapture["review"]["summaryPass"]> = {
    fallbackUsed: planned.summaryFallbackUsed,
    subjects: [...planned.summarySubjects],
  }

  if (planned.summaryPrompt) {
    summaryPass.prompt = planned.summaryPrompt
  }

  if (planned.summaryResultSource) {
    summaryPass.resultSource = planned.summaryResultSource
  }

  if (planned.summaryOpenCodeResult) {
    summaryPass.openCodeResult = captureOpenCodeResult(planned.summaryOpenCodeResult)
  }

  if (planned.summaryPassOutput) {
    summaryPass.result = planned.summaryPassOutput
  }

  const review: Types.Mutable<SandboxCapture["review"]> = {
    mode: planned.reviewMode,
    summaryPass,
    summaryState: planned.summaryState,
    summaryContent: planned.summaryContent,
    actions,
    previewThreads: projectPreviewThreads(planned.existingThreads, actions),
  }

  if (planned.prompt) {
    review.prompt = planned.prompt
  }

  if (planned.reviewResultSource) {
    review.resultSource = planned.reviewResultSource
  }

  if (planned.openCodeResult) {
    review.openCodeResult = captureOpenCodeResult(planned.openCodeResult)
  }

  if (planned.reviewResult) {
    review.result = planned.reviewResult
  }

  return {
    capture: decodeSandboxCapture({
      schemaVersion: 2,
      capturedAt: new Date().toISOString(),
      workspaceMode,
      target: {
        organization: config.organization,
        project: config.project,
        collectionUrl: config.collectionUrl,
        repositoryId: config.repositoryId,
        pullRequestId: config.pullRequestId,
      },
      metadata: planned.metadata,
      workItems: [...planned.connectedWorkItems],
      baselineThreads: [...planned.existingThreads],
      diff: {
        baseRef: planned.fullPullRequestDiff.baseRef,
        headRef: planned.fullPullRequestDiff.headRef,
        diffText: planned.fullPullRequestDiff.diffText,
        files: splitDiffByFile(planned.fullPullRequestDiff.diffText).map((file) => ({
          path: file.path,
          patch: file.patch,
          changedLineRanges: compressChangedLines(
            planned.fullPullRequestDiff.changedLinesByFile.get(file.path) ?? new Set(),
          ),
        })),
      },
      review,
    }),
    actions,
  }
}

export const executeSandboxCapture = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* SandboxCaptureConfig
    const azureClient = yield* AzureDevOpsClient
    const azureContext = createAzureContext(config)

    const metadata = yield* azureClient.getPullRequestMetadata({
      context: azureContext,
      token: config.accessToken,
    })

    const preparedWorkspace = yield* prepareSandboxWorkspace({
      requestedWorkspace: config.workspace,
      metadata,
      token: config.accessToken,
    })

    const plannedConfig: Types.Mutable<ReviewWorkflowConfig> = {
      ...config,
      systemAccessToken: config.accessToken,
      workspace: preparedWorkspace.path,
      agent: "azdo-review",
      dryRun: true,
      inheritedEnv: withoutAzureDevOpsCredentials(Bun.env),
      forceFullReview: true,
    }

    if (metadata.sourceCommitId) {
      plannedConfig.sourceCommitId = metadata.sourceCommitId
    }

    if (metadata.targetRefName) {
      plannedConfig.targetBranch = metadata.targetRefName
    }

    const planned = yield* planReviewWorkflow(plannedConfig, azureContext, undefined)

    const { actions, capture } = buildSandboxCapture({
      config,
      planned,
      workspaceMode: preparedWorkspace.mode,
    })

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(config.output), { recursive: true })
        await writeFile(config.output, `${JSON.stringify(capture)}\n`, "utf8")
      },
      catch: (error) => new Error(String(error)),
    })

    const summary = {
      status: "ok",
      output: config.output,
      verdict: planned.output.verdict,
      reviewMode: planned.reviewMode,
      actionCount: actions.length,
    }

    process.stdout.write(config.json ? `${JSON.stringify(summary)}\n` : `Wrote sandbox capture to ${config.output}\n`)

    return 0
  }),
)
