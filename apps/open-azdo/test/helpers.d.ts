import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AppConfig, type ReviewCliInput } from "../src/AppConfig"
export declare const makeBaseEnv: () => Record<string, string>
export declare const makeReviewCliInput: (overrides?: Partial<ReviewCliInput>) => ReviewCliInput
export declare const resolveAppConfig: (
  cliInput: ReviewCliInput,
  env: Record<string, string | undefined>,
) => Effect.Effect<
  import("../src/AppConfig").AppConfigShape,
  import("effect/Config").ConfigError | import("../src/errors").ConfigError,
  never
>
export declare const makeSilentRuntimeLayer: (
  cliInput: ReviewCliInput,
) => Layer.Layer<
  | AppConfig
  | import("@open-azdo/azdo/client").AzureDevOpsClient
  | import("@open-azdo/core/git").GitExec
  | import("@open-azdo/core/opencode").OpenCodeRunner
  | import("@open-azdo/core/process-runner").ProcessRunner
  | BunServices.BunServices,
  import("effect/Config").ConfigError | import("../src/errors").ConfigError,
  never
>
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
export declare const createTempDir: (prefix: string) => Promise<string>
export declare const createFixtureRepo: () => Promise<{
  featureSha: string
  mainSha: string
  repoDir: string
}>
