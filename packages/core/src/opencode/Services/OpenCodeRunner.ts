import type { OutputFormat } from "@opencode-ai/sdk/v2"
import { ServiceMap } from "effect"
import type { Duration } from "effect/Duration"
import type { Effect } from "effect"

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

export type OpenCodeJsonSchemaOutputFormat = Extract<OutputFormat, { readonly type: "json_schema" }>

export type OpenCodeOutputFormat = OutputFormat

export type OpenCodeModelError = {
  readonly name: string
  readonly message: string
  readonly retries?: number | undefined
}

export type OpenCodeRunResult = {
  readonly response: string
  readonly structured?: unknown
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

export interface OpenCodeRunnerShape {
  readonly run: (
    request: OpenCodeRunRequest,
  ) => Effect.Effect<OpenCodeRunResult, OpenCodeInvocationError | OpenCodeOutputError>
}

export class OpenCodeRunner extends ServiceMap.Service<OpenCodeRunner, OpenCodeRunnerShape>()(
  "open-azdo/opencode/OpenCodeRunner",
) {}
