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
  workItemRefs: [],
  ...overrides,
})

export type FetchCall = {
  readonly url: string
  readonly init: RequestInit | undefined
}

export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

const decodeBodyInit = async (body: BodyInit | null | undefined) => {
  if (body === undefined || body === null) {
    return undefined
  }

  if (typeof body === "string") {
    return body
  }

  if (body instanceof URLSearchParams) {
    return body.toString()
  }

  if (body instanceof Blob) {
    return await body.text()
  }

  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body))
  }

  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  }

  return body
}

const normalizeFetchCall = async (url: string | URL | Request, init?: RequestInit) => {
  const normalizedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url
  const body =
    init?.body !== undefined
      ? await decodeBodyInit(init.body)
      : url instanceof Request
        ? await url.clone().text()
        : undefined

  if (url instanceof Request) {
    return {
      url: normalizedUrl,
      init: {
        method: init?.method ?? url.method,
        headers: init?.headers ?? url.headers,
        ...(body !== undefined ? { body } : {}),
        signal: init?.signal ?? url.signal,
      } satisfies RequestInit,
    }
  }

  return {
    url: normalizedUrl,
    init:
      init === undefined
        ? undefined
        : ({
            ...init,
            ...(body !== undefined ? { body } : {}),
          } satisfies RequestInit),
  }
}

export const makeFetchMock = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: FetchCall[] = []
  const fetchMock: FetchLike = async (url, init) => {
    const normalizedCall = await normalizeFetchCall(url, init)
    calls.push(normalizedCall)
    return handler(normalizedCall.url, normalizedCall.init)
  }

  return {
    calls,
    fetchMock,
  }
}

export const systemToken = Redacted.make("system-token")
