import { Effect, Option, Schema } from "effect"

import { SandboxCaptureSchema, SandboxThreadSchema, type SandboxCapture } from "@open-azdo/sandbox/capture"

/** A connected work item retained in a capture artifact. */
export type CaptureWorkItem = SandboxCapture["workItems"][number]

const PromptThreadSchema = Schema.Struct({
  id: Schema.Int,
  status: SandboxThreadSchema.fields.status,
  filePath: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Int),
  updatedAt: Schema.optionalKey(Schema.String),
  managedThread: Schema.Boolean,
  comments: Schema.Array(
    Schema.Struct({
      author: Schema.String,
      publishedAt: Schema.optionalKey(Schema.String),
      origin: Schema.Literals(["human", "open-azdo"]),
      content: Schema.String,
    }),
  ),
})

/** A decoded conversation thread from the context embedded in the review prompt. */
export interface PromptThread extends Schema.Schema.Type<typeof PromptThreadSchema> {}

// Sections are independently optional: malformed work items must not hide usable thread context, or vice versa.
const PromptContextSchema = Schema.Struct({
  pullRequestThreads: Schema.optionalKey(
    Schema.Struct({
      omittedCount: Schema.Int,
      items: Schema.Array(PromptThreadSchema),
    }),
  ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.none()))),
  connectedWorkItems: Schema.optionalKey(
    Schema.Struct({
      omittedCount: Schema.Int,
      items: SandboxCaptureSchema.fields.workItems,
    }),
  ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.none()))),
})

const PROMPT_CONTEXT_HEADER = /(?:^|\n)Pull request context:[ \t]*\r?\n/g
const decodePromptContext = Schema.decodeUnknownOption(Schema.fromJsonString(PromptContextSchema))

/** Decode the embedded JSON once; absent or malformed context uses the capture fallback. */
const extractPromptContext = (prompt: string | undefined) => {
  if (!prompt) return undefined
  // Match the appended heading, not marker-like source lines in the patch or strings inside JSON.
  const header = Array.from(prompt.matchAll(PROMPT_CONTEXT_HEADER)).at(-1)

  if (!header) return undefined

  // Capture validation treats the prompt as text, so its nested JSON is a separate trust boundary.
  return Option.getOrUndefined(decodePromptContext(prompt.slice(header.index + header[0].length).trim()))
}

/**
 * Resolved context data ready for display in the sandbox UI.
 * Prioritises data extracted from the prompt's ReviewContext JSON when available,
 * and falls back to the capture's top-level `workItems` when unavailable.
 */
export interface ResolvedContext {
  /** Work items from the prompt context, or top-level capture work items as fallback. */
  readonly workItems: ReadonlyArray<CaptureWorkItem>
  /** Count of work items that were omitted from the prompt due to budget constraints. */
  readonly workItemsOmittedCount: number
  /** Whether the work items data came from the prompt's embedded ReviewContext JSON. */
  readonly workItemsFromPrompt: boolean
  /** Threads from the prompt context, or `undefined` when not available. */
  readonly promptThreads: ReadonlyArray<PromptThread> | undefined
  /** Count of threads omitted from the prompt due to budget constraints. */
  readonly threadsOmittedCount: number
}

/**
 * Extracts prompt context from the capture's review prompt and merges it with
 * top-level capture data. Prompt-embedded data is preferred when available
 * (it represents what the model actually saw). Falls back to `capture.workItems`
 * for work items and returns `undefined` for prompt threads when unavailable.
 */
export const resolveCaptureContext = (capture: SandboxCapture): ResolvedContext => {
  const promptCtx = extractPromptContext(capture.review.prompt)
  const promptWorkItems = promptCtx?.connectedWorkItems
  const promptThreads = promptCtx?.pullRequestThreads

  const workItemsFromPrompt = promptWorkItems !== undefined
  const workItems = promptWorkItems?.items ?? capture.workItems
  const workItemsOmittedCount = promptWorkItems?.omittedCount ?? 0
  const threadsOmittedCount = promptThreads?.omittedCount ?? 0

  return {
    workItems,
    workItemsOmittedCount,
    workItemsFromPrompt,
    promptThreads: promptThreads?.items,
    threadsOmittedCount,
  }
}
