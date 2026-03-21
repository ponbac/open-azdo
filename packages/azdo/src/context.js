export const createAzureContext = (input) => ({
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
export const buildBuildLink = (input) => {
  if (input.buildUri) {
    return input.buildUri
  }
  if (input.buildId) {
    return `${input.collectionUrl.replace(/\/+$/, "")}/${encodeURIComponent(input.project)}/_build/results?buildId=${encodeURIComponent(input.buildId)}`
  }
  return undefined
}
