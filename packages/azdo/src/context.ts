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

/** Normalizes the collection base URL while preserving omission of unavailable build metadata. */
export const createAzureContext = (input: AzureContextInput): AzureContext => {
  let context: AzureContext = {
    organization: input.organization,
    project: input.project,
    collectionUrl: input.collectionUrl.replace(/\/+$/, ""),
    repositoryId: input.repositoryId,
    pullRequestId: input.pullRequestId,
  }

  if (input.buildId !== undefined) context = { ...context, buildId: input.buildId }

  if (input.buildNumber !== undefined) context = { ...context, buildNumber: input.buildNumber }

  if (input.buildUri !== undefined) context = { ...context, buildUri: input.buildUri }

  if (input.sourceVersion !== undefined) context = { ...context, sourceVersion: input.sourceVersion }

  if (input.targetBranch !== undefined) context = { ...context, targetBranch: input.targetBranch }

  return context
}

export const buildBuildLink = (input: Pick<AzureContext, "buildUri" | "collectionUrl" | "project" | "buildId">) => {
  if (input.buildUri) {
    return input.buildUri
  }

  if (input.buildId) {
    return `${input.collectionUrl.replace(/\/+$/, "")}/${encodeURIComponent(input.project)}/_build/results?buildId=${encodeURIComponent(input.buildId)}`
  }

  return undefined
}
