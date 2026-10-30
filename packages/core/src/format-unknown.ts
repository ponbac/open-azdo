import { Inspectable } from "effect"

/** Formats external error causes for adapter diagnostics, retaining Error messages without their stacks. */
export const formatUnknownDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : Inspectable.toStringUnknown(cause, 0)
