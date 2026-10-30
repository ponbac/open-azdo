import { Context } from "effect"
import type * as Duration from "effect/Duration"
import type { Effect, Schema } from "effect"

import type { OpenCodeInvocationError, OpenCodeOutputError } from "../../../errors"
import type { OpenCodeModelError, OpenCodeOutputFormat, OpenCodeRunUsage } from "../../Services/OpenCodeRunner"

/** One ordered OpenCode V2 permission rule. The last matching rule wins and unmatched requests ask. */
export type OpenCodePermissionRule = {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/** The subset of the OpenCode V2 server config that open-azdo generates for each run. */
export type OpenCodeConfig = {
  readonly $schema: string
  readonly update: "disable"
  readonly default_agent: string
  readonly instructions?: ReadonlyArray<string>
  readonly agents: Readonly<
    Record<
      string,
      {
        readonly mode: "primary"
        readonly description: string
        readonly permissions: ReadonlyArray<OpenCodePermissionRule>
      }
    >
  >
  readonly plugins?: ReadonlyArray<{
    readonly package: string
    readonly options: { readonly schema?: Schema.JsonObject }
  }>
}

/**
 * Name of the plugin tool that replaces V1's native `format` prompt option.
 * The tool input is the run's structured result, so the agent must be allowed
 * to call it.
 */
export const OPEN_CODE_STRUCTURED_OUTPUT_TOOL = "open_azdo_submit_result"

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
  readonly config: OpenCodeConfig
}

export type OpenCodeSdkPromptResult = {
  readonly response: string
  readonly structured?: Schema.Json
  readonly sessionId?: string | undefined
  readonly usage?: OpenCodeRunUsage | undefined
  readonly modelError?: OpenCodeModelError | undefined
}

/** Owns the private server, session, and cancellation scope for one OpenCode prompt. */
export interface OpenCodeSdkRuntimeService {
  readonly prompt: (
    request: OpenCodeSdkPromptRequest,
  ) => Effect.Effect<OpenCodeSdkPromptResult, OpenCodeInvocationError | OpenCodeOutputError>
}

export class OpenCodeSdkRuntime extends Context.Service<OpenCodeSdkRuntime, OpenCodeSdkRuntimeService>()(
  "open-azdo/opencode/internal/OpenCodeSdkRuntime",
) {}
