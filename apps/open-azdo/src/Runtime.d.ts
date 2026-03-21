import { Layer } from "effect"
import { type ReviewCliInput } from "./AppConfig"
export declare const makeRuntimeLayer: (
  cliInput: ReviewCliInput,
) => Layer.Layer<
  | import("./AppConfig").AppConfig
  | import("@open-azdo/azdo/client").AzureDevOpsClient
  | import("@open-azdo/core/git").GitExec
  | import("@open-azdo/core/opencode").OpenCodeRunner
  | import("@open-azdo/core/process-runner").ProcessRunner
  | import("@effect/platform-bun/BunServices").BunServices,
  import("effect/Config").ConfigError | import("./errors").ConfigError,
  never
>
