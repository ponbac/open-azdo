import { Redacted } from "effect"
import { createAzureContext } from "@open-azdo/azdo/client"
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
export const makePullRequestMetadata = (overrides = {}) => ({
  title: "Feature PR",
  description: "Adds a new export",
  ...overrides,
})
export const makeFetchMock = (handler) => {
  const calls = []
  const fetchMock = async (url, init) => {
    const normalizedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url
    calls.push({ url: normalizedUrl, init })
    return handler(normalizedUrl, init)
  }
  return {
    calls,
    fetchMock,
  }
}
export const createMockFetch = (fetchMock, originalFetch) => {
  const mockedFetch = (input, init) => fetchMock(input, init)
  mockedFetch.preconnect = originalFetch.preconnect.bind(originalFetch)
  return mockedFetch
}
export const systemToken = Redacted.make("system-token")
