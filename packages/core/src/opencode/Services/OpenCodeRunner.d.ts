import { ServiceMap } from "effect"
import type { Duration } from "effect/Duration"
import type { Effect } from "effect"
import type { OpenCodeInvocationError, OpenCodeOutputError } from "../../errors"
export type OpenCodeRunRequest = {
  readonly workspace: string
  readonly model: string
  readonly agent: string
  readonly variant: string | undefined
  readonly timeout: Duration
  readonly prompt: string
  readonly inheritedEnv: NodeJS.ProcessEnv
}
export interface OpenCodeRunnerShape {
  readonly run: (request: OpenCodeRunRequest) => Effect.Effect<string, OpenCodeInvocationError | OpenCodeOutputError>
}
declare const OpenCodeRunner_base: ServiceMap.ServiceClass<
  OpenCodeRunner,
  "open-azdo/opencode/OpenCodeRunner",
  OpenCodeRunnerShape
>
export declare class OpenCodeRunner extends OpenCodeRunner_base {}
export {}
