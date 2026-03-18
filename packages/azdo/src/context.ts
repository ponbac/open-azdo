export type AzureContext = {
  readonly organization: string
  readonly project: string
  readonly collectionUrl: string
  readonly repositoryId: string
  readonly pullRequestId: number
  readonly buildId?: string
  readonly buildNumber?: string
  readonly buildUri?: string
  readonly sourceVersion?: string
  readonly targetBranch?: string
}

export type AzureContextInput = AzureContext

export const createAzureContext = (input: AzureContextInput): AzureContext => ({
  organization: input.organization,
  project: input.project,
  collectionUrl: input.collectionUrl.replace(/\/+$/, ""),
  repositoryId: input.repositoryId,
  pullRequestId: input.pullRequestId,
  ...(input.buildId !== undefined ? { buildId: input.buildId } : {}),
  ...(input.buildNumber !== undefined ? { buildNumber: input.buildNumber } : {}),
  ...(input.buildUri !== undefined ? { buildUri: input.buildUri } : {}),
  ...(input.sourceVersion !== undefined ? { sourceVersion: input.sourceVersion } : {}),
  ...(input.targetBranch !== undefined ? { targetBranch: input.targetBranch } : {}),
})

export const buildBuildLink = (input: Pick<AzureContext, "buildUri" | "collectionUrl" | "project" | "buildId">) => {
  if (input.buildUri) {
    return input.buildUri
  }

  if (input.buildId) {
    return `${input.collectionUrl.replace(/\/+$/, "")}/${encodeURIComponent(input.project)}/_build/results?buildId=${encodeURIComponent(input.buildId)}`
  }

  return undefined
}
