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

export type FetchLike = typeof globalThis.fetch

/** Uses the platform body decoder so mocked calls retain the real fetch body contract. */
const decodeBodyInit = async (body: BodyInit | null | undefined) =>
  body === undefined || body === null ? undefined : await new Response(body).text()

const normalizeFetchCall = async (url: string | URL | Request, init?: RequestInit) => {
  const normalizedUrl = url instanceof Request ? url.url : String(url)

  const body =
    init?.body !== undefined
      ? await decodeBodyInit(init.body)
      : url instanceof Request
        ? await url.clone().text()
        : undefined

  if (url instanceof Request) {
    const normalizedInit: RequestInit = {
      method: init?.method ?? url.method,
      headers: init?.headers ?? url.headers,
      signal: init?.signal ?? url.signal,
    }

    if (body !== undefined) normalizedInit.body = body

    return { url: normalizedUrl, init: normalizedInit }
  }

  if (init === undefined) return { url: normalizedUrl, init: undefined }

  const normalizedInit = { ...init }

  if (body !== undefined) normalizedInit.body = body

  return { url: normalizedUrl, init: normalizedInit }
}

/** Adapts a response handler to the real fetch contract, including a no-I/O preconnect stub. */
export const makeFetchMock = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetchMock: FetchLike = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const normalizedCall = await normalizeFetchCall(url, init)

      return handler(normalizedCall.url, normalizedCall.init)
    },
    { preconnect: () => {} },
  )

  return {
    fetchMock,
  }
}

export const systemToken = Redacted.make("system-token")
