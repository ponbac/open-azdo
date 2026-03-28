/**
 * Shared utilities, types, and micro-components for the sandbox UI.
 * Keeps layout modules focused on presentation rather than data plumbing.
 */
import { Schema } from "effect"
import { startTransition, useId, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { useMarkdownComponents } from "./pierre"

import { SandboxCaptureSchema, type SandboxCapture, type SandboxThread } from "@open-azdo/sandbox/capture"

import { demoCapture } from "./DemoCapture"

// ── Re-exports for convenience ─────────────────────────────────

/** Work item type as stored in the capture's top-level `workItems` array. */
export type CaptureWorkItem = SandboxCapture["workItems"][number]

// ── Derived types ──────────────────────────────────────────────

type ReviewHistory = NonNullable<SandboxCapture["review"]["summaryState"]["reviewHistory"]>[number]

// ── Prompt context types ───────────────────────────────────────

/** A single comment inside a thread as embedded in the prompt's ReviewContext JSON. */
type PromptThreadComment = {
  readonly author: string
  readonly publishedAt?: string
  readonly origin: "human" | "open-azdo"
  readonly content: string
}

/** A thread as embedded in the prompt's ReviewContext JSON. */
export type PromptThread = {
  readonly id: number
  readonly status?: string | number
  readonly filePath?: string
  readonly line?: number
  readonly updatedAt?: string
  readonly managedThread: boolean
  readonly comments: ReadonlyArray<PromptThreadComment>
}

/**
 * The structured context extracted from the ReviewContext JSON that was
 * embedded in the prompt after the `"Pull request context:"` marker.
 * Contains the threads and work items that the model actually saw.
 */
type PromptContext = {
  readonly pullRequestThreads?:
    | {
        readonly omittedCount: number
        readonly items: ReadonlyArray<PromptThread>
      }
    | undefined
  readonly connectedWorkItems?:
    | {
        readonly omittedCount: number
        readonly items: ReadonlyArray<CaptureWorkItem>
      }
    | undefined
}

// ── Prompt context extraction ──────────────────────────────────

const PROMPT_CONTEXT_MARKER = "Pull request context:"

/**
 * Extract the structured ReviewContext from the prompt string.
 * The prompt builder appends `"Pull request context:\n{json}"` at the end.
 * Returns `undefined` when the marker or JSON is missing / unparseable.
 */
const extractPromptContext = (prompt: string | undefined): PromptContext | undefined => {
  if (!prompt) return undefined
  const idx = prompt.indexOf(PROMPT_CONTEXT_MARKER)
  if (idx < 0) return undefined
  const jsonStr = prompt.slice(idx + PROMPT_CONTEXT_MARKER.length).trim()
  if (!jsonStr) return undefined
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>
    return {
      pullRequestThreads: parsed.pullRequestThreads as PromptContext["pullRequestThreads"],
      connectedWorkItems: parsed.connectedWorkItems as PromptContext["connectedWorkItems"],
    }
  } catch {
    return undefined
  }
}

// ── Decode helper ──────────────────────────────────────────────

const decodeCapture = Schema.decodeUnknownSync(SandboxCaptureSchema)

// ── Formatters ─────────────────────────────────────────────────

export const formatDateTime = (value: string | undefined) =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
        hour12: false,
      }).format(new Date(value))
    : "Unknown"

export const normalizePath = (value: string | undefined) => (value ?? "").replace(/^\//, "")

export const threadPath = (thread: SandboxThread) => normalizePath(thread.threadContext?.filePath)

export const shortPath = (path: string) => path.split("/").pop() ?? path

export const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const formatCost = (usd: number | undefined) => (usd !== undefined ? `$${usd.toFixed(4)}` : "n/a")

/** Sum total cost across all review history entries. */
export const totalHistoryCost = (history: readonly ReviewHistory[]) =>
  history.reduce((sum, h) => sum + (h.costUsd ?? 0), 0)

/** Sum total tokens across all review history entries. */
export const totalHistoryTokens = (history: readonly ReviewHistory[]) =>
  history.reduce(
    (acc, h) => {
      if (!h.tokens) return acc
      return {
        input: acc.input + h.tokens.input,
        output: acc.output + h.tokens.output,
        reasoning: acc.reasoning + h.tokens.reasoning,
        cacheRead: acc.cacheRead + h.tokens.cacheRead,
        cacheWrite: acc.cacheWrite + h.tokens.cacheWrite,
      }
    },
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  )

export const verdictTone = (v: string | undefined) =>
  v === "pass" ? ("success" as const) : v === "fail" ? ("danger" as const) : ("warn" as const)

/**
 * Filter baseline threads to only those that are meaningful for review display.
 * Removes system noise like policy updates, ref updates, and auto-complete messages.
 */
export const filterReviewThreads = (threads: readonly SandboxThread[]) =>
  threads.filter((t) => {
    const firstComment = t.comments[0]
    if (!firstComment) return false
    const content = firstComment.content ?? ""
    const author = firstComment.author?.displayName ?? ""
    // Skip system-generated noise threads
    if (author === "Microsoft.VisualStudio.Services.TFS") return false
    if (content.startsWith("Policy status has been updated")) return false
    if (content.includes("set auto-complete")) return false
    if (content.startsWith("The reference refs/")) return false
    if (content.includes("published the pull request")) return false
    // Skip Azure Pipelines system threads
    if (author === "Azure Pipelines Test Service") return false
    return true
  })

// ── Shared hook: capture state management ──────────────────────

interface CaptureState {
  readonly capture: SandboxCapture
  readonly error: string | undefined
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>
  readonly inputId: string
  readonly applyCapture: (candidate: unknown) => void
  readonly onImportFile: (file: File | undefined) => Promise<void>
  readonly onReset: () => void
}

export const useCaptureState = (): CaptureState => {
  const inputId = useId()
  const [capture, setCapture] = useState<SandboxCapture>(demoCapture)
  const [error, setError] = useState<string | undefined>()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const applyCapture = (candidate: unknown) => {
    try {
      const next = decodeCapture(candidate)
      startTransition(() => {
        setCapture(next)
        setError(undefined)
      })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  const onImportFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const text = await file.text()
      applyCapture(JSON.parse(text))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  const onReset = () => {
    startTransition(() => {
      setCapture(demoCapture)
      setError(undefined)
    })
  }

  return { capture, error, fileInputRef, inputId, applyCapture, onImportFile, onReset }
}

// ── Markdown renderer ──────────────────────────────────────────

export const Markdown = ({ children, className }: { readonly children: string; readonly className?: string }) => {
  const components = useMarkdownComponents()
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}

// ── Collapsible text block ─────────────────────────────────────

export const CollapsibleText = ({
  content,
  maxLength = 200,
  className,
}: {
  readonly content: string
  readonly maxLength?: number
  readonly className?: string
}) => {
  const [expanded, setExpanded] = useState(false)
  const isLong = content.length > maxLength

  return (
    <div className={className}>
      <Markdown>{isLong && !expanded ? `${content.slice(0, maxLength)}...` : content}</Markdown>
      {isLong ? (
        <button
          className="mt-1 text-xs opacity-60 hover:opacity-100 underline"
          onClick={() => setExpanded((prev) => !prev)}
          type="button"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  )
}

// ── Hidden file input ──────────────────────────────────────────

export const HiddenFileInput = ({
  inputId,
  fileInputRef,
  onImportFile,
}: {
  readonly inputId: string
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>
  readonly onImportFile: (file: File | undefined) => Promise<void>
}) => (
  <input
    accept="application/json"
    className="hidden"
    id={inputId}
    onChange={(event) => void onImportFile(event.target.files?.[0])}
    ref={fileInputRef}
    type="file"
  />
)

// ── Shared view props ──────────────────────────────────────────

export interface SandboxViewProps {
  readonly state: CaptureState
}

// ── Resolved context hook ──────────────────────────────────────

/**
 * Resolved context data ready for display in the sandbox UI.
 * Prioritises data extracted from the prompt's ReviewContext JSON when available,
 * and falls back to the capture's top-level `workItems` and filtered `baselineThreads`.
 */
interface ResolvedContext {
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
export const useResolvedContext = (capture: SandboxCapture): ResolvedContext => {
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
