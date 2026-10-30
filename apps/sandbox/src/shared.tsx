/**
 * Shared utilities, types, and micro-components for the sandbox UI.
 * Keeps layout modules focused on presentation rather than data plumbing.
 */
import { DateTime, Match, Option, Schema } from "effect"
import { startTransition, useId, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { useMarkdownComponents } from "./pierre"

import { SandboxCaptureSchema, type SandboxCapture, type SandboxThread } from "@open-azdo/sandbox/capture"

import { demoCapture } from "./DemoCapture"

// ── Derived types ──────────────────────────────────────────────

type ReviewHistory = NonNullable<SandboxCapture["review"]["summaryState"]["reviewHistory"]>[number]

// ── Formatters ─────────────────────────────────────────────────

/** Format capture timestamps in UTC, using the missing-date label for malformed imported values. */
export const formatDateTime = (value: string | undefined) => {
  if (!value) return "Unknown"
  const date = DateTime.make(value)

  if (Option.isNone(date)) return "Unknown"

  return DateTime.format(date.value, {
    locale: "en-US",
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
    hour12: false,
  })
}

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

/** Map review verdicts to display tones; absent verdicts retain the warning tone. */
export const verdictTone = (verdict: string | undefined): "success" | "danger" | "warn" =>
  Match.value(verdict).pipe(
    Match.when("pass", () => "success" as const),
    Match.when("fail", () => "danger" as const),
    Match.orElse(() => "warn" as const),
  )

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
  readonly onImportFile: (file: File | undefined) => Promise<void>
  readonly onReset: () => void
}

export const useCaptureState = (): CaptureState => {
  const inputId = useId()
  const [capture, setCapture] = useState<SandboxCapture>(demoCapture)
  const [error, setError] = useState<string | undefined>()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const onImportFile = async (file: File | undefined) => {
    if (!file) return

    try {
      // The file is the trust boundary: parse its JSON directly into the capture contract.
      const next = Schema.decodeSync(Schema.fromJsonString(SandboxCaptureSchema))(await file.text())

      startTransition(() => {
        setCapture(next)
        setError(undefined)
      })
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

  return { capture, error, fileInputRef, inputId, onImportFile, onReset }
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
