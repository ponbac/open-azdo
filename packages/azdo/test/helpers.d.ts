import { Redacted } from "effect"
import type { PullRequestMetadata } from "@open-azdo/azdo/schemas"
export declare const makeAzureContext: () => import("@open-azdo/azdo/client").AzureContext
export declare const makePullRequestMetadata: (overrides?: Partial<PullRequestMetadata>) => PullRequestMetadata
export type FetchCall = {
  readonly url: string
  readonly init: RequestInit | undefined
}
export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>
export declare const makeFetchMock: (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  calls: FetchCall[]
  fetchMock: FetchLike
}
export declare const createMockFetch: (fetchMock: FetchLike, originalFetch: typeof fetch) => typeof fetch
export declare const systemToken: Redacted.Redacted<string>
