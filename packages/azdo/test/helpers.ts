import { Redacted } from "effect"

import { createAzureContext } from "@open-azdo/azdo/client"
import type { PullRequestMetadata } from "@open-azdo/azdo/schemas"

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

export const makePullRequestMetadata = (overrides: Partial<PullRequestMetadata> = {}): PullRequestMetadata => ({
  title: "Feature PR",
  description: "Adds a new export",
  ...overrides,
})

export type FetchCall = {
  readonly url: string
  readonly init: RequestInit | undefined
}

export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

export const makeFetchMock = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: FetchCall[] = []
  const fetchMock: FetchLike = async (url, init) => {
    const normalizedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url
    calls.push({ url: normalizedUrl, init })
    return handler(normalizedUrl, init)
  }

  return {
    calls,
    fetchMock,
  }
}

export const createMockFetch = (fetchMock: FetchLike, originalFetch: typeof fetch): typeof fetch => {
  const mockedFetch: typeof fetch = (input, init) => fetchMock(input, init)
  mockedFetch.preconnect = originalFetch.preconnect.bind(originalFetch)
  return mockedFetch
}

export const systemToken = Redacted.make("system-token")
