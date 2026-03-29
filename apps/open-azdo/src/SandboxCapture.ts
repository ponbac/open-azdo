import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { Effect } from "effect"

import { AzureDevOpsClient, createAzureContext } from "@open-azdo/azdo/client"
import { compressChangedLines, splitDiffByFile } from "@open-azdo/core/git"
import { stringifyJson } from "@open-azdo/core/json"
import { planReviewWorkflow, type PlannedReviewWorkflow } from "@open-azdo/workflows/review"
import { decodeSandboxCapture, projectPreviewThreads, toSandboxPreviewAction } from "@open-azdo/sandbox/capture"

import { SandboxCaptureConfig } from "./SandboxCaptureConfig"
import { prepareSandboxWorkspace } from "./live/Workspace"

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
      review: {
        mode: planned.reviewMode,
        ...(planned.prompt ? { prompt: planned.prompt } : {}),
        ...(planned.reviewResultSource ? { resultSource: planned.reviewResultSource } : {}),
        ...(planned.openCodeResult ? { openCodeResult: planned.openCodeResult } : {}),
        ...(planned.reviewResult ? { result: planned.reviewResult } : {}),
        summaryPass: {
          ...(planned.summaryPrompt ? { prompt: planned.summaryPrompt } : {}),
          ...(planned.summaryResultSource ? { resultSource: planned.summaryResultSource } : {}),
          ...(planned.summaryOpenCodeResult ? { openCodeResult: planned.summaryOpenCodeResult } : {}),
          ...(planned.summaryPassOutput ? { result: planned.summaryPassOutput } : {}),
          fallbackUsed: planned.summaryFallbackUsed,
          subjects: [...planned.summarySubjects],
        },
        summaryState: planned.summaryState,
        summaryContent: planned.summaryContent,
        actions,
        previewThreads: projectPreviewThreads(planned.existingThreads, actions),
      },
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

    const plannedConfig = {
      ...config,
      systemAccessToken: config.accessToken,
      workspace: preparedWorkspace.path,
      agent: "azdo-review",
      dryRun: true,
      inheritedEnv: Bun.env,
      forceFullReview: true,
      ...(metadata.sourceCommitId ? { sourceCommitId: metadata.sourceCommitId } : {}),
      ...(metadata.targetRefName ? { targetBranch: metadata.targetRefName } : {}),
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
        await writeFile(config.output, `${stringifyJson(capture)}\n`, "utf8")
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

    process.stdout.write(config.json ? `${stringifyJson(summary)}\n` : `Wrote sandbox capture to ${config.output}\n`)
    return 0
  }),
)
