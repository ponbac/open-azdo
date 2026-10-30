import { Context } from "effect"
import type { Duration } from "effect/Duration"
import type { Effect, Schema } from "effect"

import type { OpenCodeInvocationError, OpenCodeOutputError } from "../../errors"

export type OpenCodeRunTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type OpenCodeRunUsage = {
  readonly costUsd?: number | undefined
  readonly tokens?: OpenCodeRunTokens | undefined
}

/** JSON-compatible schema passed to the scoped OpenCode submission tool. */
export type OpenCodeJsonSchemaOutputFormat = {
  readonly type: "json_schema"
  readonly schema: Schema.JsonObject
}

/** Requested run output. V2 has no native format option; see the SDK runtime for how JSON schemas are enforced. */
export type OpenCodeOutputFormat = { readonly type: "text" } | OpenCodeJsonSchemaOutputFormat

export type OpenCodeModelError = {
  readonly name: string
  readonly message: string
}

export type OpenCodeRunResult = {
  readonly response: string
  readonly structured?: Schema.Json
  readonly modelError?: OpenCodeModelError | undefined
  readonly sessionId?: string | undefined
  readonly usage?: OpenCodeRunUsage | undefined
}

export type OpenCodeRunRequest = {
  readonly workspace: string
  readonly model: string
  readonly agent: string
  readonly variant: string | undefined
  readonly timeout: Duration
  readonly prompt: string
  readonly inheritedEnv: NodeJS.ProcessEnv
  readonly format?: OpenCodeOutputFormat | undefined
}

/** Runs one bounded assistant review with repository inspection and shell-based verification. */
export interface OpenCodeRunnerService {
  readonly run: (
    request: OpenCodeRunRequest,
  ) => Effect.Effect<OpenCodeRunResult, OpenCodeInvocationError | OpenCodeOutputError>
}

export class OpenCodeRunner extends Context.Service<OpenCodeRunner, OpenCodeRunnerService>()(
  "open-azdo/opencode/OpenCodeRunner",
) {}

/**
 * Build the model process environment without Azure job credentials, preserving provider credentials.
 * Matching names without case protects Windows environments and explicitly supplied case variants.
 * This does not isolate the parent process or remove credentials stored outside these variables.
 */
export const withoutAzureDevOpsCredentials = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(([name]) => {
      const normalized = name.toUpperCase()

      return normalized !== "SYSTEM_ACCESSTOKEN" && normalized !== "OPEN_AZDO_LIVE_ACCESS_TOKEN"
    }),
  )
