import type { Config } from "@opencode-ai/sdk/v2"

import { ServiceMap } from "effect"
import type * as Duration from "effect/Duration"
import type { Effect } from "effect"

import type { OpenCodeInvocationError, OpenCodeOutputError } from "../../../errors"
import type { OpenCodeModelError, OpenCodeOutputFormat, OpenCodeRunUsage } from "../../Services/OpenCodeRunner"

export type OpenCodeSdkPromptRequest = {
  readonly workspace: string
  readonly model: {
    readonly providerID: string
    readonly modelID: string
  }
  readonly agent: string
  readonly variant?: string | undefined
  readonly timeout: Duration.Duration
  readonly prompt: string
  readonly inheritedEnv: NodeJS.ProcessEnv
  readonly format?: OpenCodeOutputFormat | undefined
  readonly config: Config
}

export type OpenCodeSdkPromptResult = {
  readonly response: string
  readonly structured?: unknown
  readonly sessionId?: string | undefined
  readonly usage?: OpenCodeRunUsage | undefined
  readonly modelError?: OpenCodeModelError | undefined
}

export interface OpenCodeSdkRuntimeShape {
  readonly prompt: (
    request: OpenCodeSdkPromptRequest,
  ) => Effect.Effect<OpenCodeSdkPromptResult, OpenCodeInvocationError | OpenCodeOutputError>
}

export class OpenCodeSdkRuntime extends ServiceMap.Service<OpenCodeSdkRuntime, OpenCodeSdkRuntimeShape>()(
  "open-azdo/opencode/internal/OpenCodeSdkRuntime",
) {}
