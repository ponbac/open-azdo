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
export declare const createAzureContext: (input: AzureContextInput) => AzureContext
export declare const buildBuildLink: (
  input: Pick<AzureContext, "buildUri" | "collectionUrl" | "project" | "buildId">,
) => string | undefined
