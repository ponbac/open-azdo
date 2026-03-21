import { Effect } from "effect"
export declare const cliProgram: Effect.Effect<
  void,
  import("./errors").OperationalError | import("effect/unstable/cli/CliError").CliError,
  never
>
export declare const main: () => void
