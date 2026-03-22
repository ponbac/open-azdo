import { Schema } from "effect"
import { startTransition, type ComponentProps, type ReactNode, useEffect, useId, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { SandboxCaptureSchema, type SandboxCapture, type SandboxThread } from "@open-azdo/sandbox/capture"

import { demoCapture } from "./DemoCapture"

// ── Types ──────────────────────────────────────────────────────

type BottomTab = "prompt" | "raw"
type FocusTarget = { readonly path: string; readonly line?: number }

// ── Constants ──────────────────────────────────────────────────

const decodeCapture = Schema.decodeUnknownSync(SandboxCaptureSchema)

// ── Utilities ──────────────────────────────────────────────────

const formatDateTime = (value: string | undefined) =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
        hour12: false,
      }).format(new Date(value))
    : "Unknown"

const formatStatus = (status: SandboxThread["status"]) => {
  switch (status) {
    case 1:
    case "active":
      return "Active"
    case 2:
    case "fixed":
    case "closed":
      return "Closed"
    case "wontFix":
      return "Won't fix"
    case "pending":
      return "Pending"
    case "byDesign":
      return "By design"
    default:
      return "Unknown"
  }
}

const normalizePath = (value: string | undefined) => (value ?? "").replace(/^\//, "")
const threadPath = (thread: SandboxThread) => normalizePath(thread.threadContext?.filePath)
const toFocusTarget = (path: string, line?: number): FocusTarget => (line === undefined ? { path } : { path, line })
const shortPath = (path: string) => path.split("/").pop() ?? path

const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx"

const diffLineKind = (line: string): DiffLineKind => {
  if (line.startsWith("@@")) return "hunk"
  if (line.startsWith("diff") || line.startsWith("index") || line.startsWith("+++") || line.startsWith("---"))
    return "meta"
  if (line.startsWith("+")) return "add"
  if (line.startsWith("-")) return "del"
  return "ctx"
}

// ── Shared micro-components ────────────────────────────────────

const Chevron = ({ open, className }: { readonly open: boolean; readonly className?: string }) => (
  <svg
    aria-hidden="true"
    className={`inline-block transition-transform duration-150 ${open ? "rotate-90" : ""} ${className ?? ""}`}
    fill="none"
    height="10"
    stroke="currentColor"
    strokeLinecap="round"
    strokeWidth="1.8"
    viewBox="0 0 10 10"
    width="10"
  >
    <path d="M3.5 1.5L7 5L3.5 8.5" />
  </svg>
)

const markdownComponents = {
  p: (props: ComponentProps<"p">) => <p className="mb-2 leading-relaxed last:mb-0" {...props} />,
  h1: (props: ComponentProps<"h1">) => (
    <h1 className="mb-2 text-base font-bold text-[color:var(--text-primary)]" {...props} />
  ),
  h2: (props: ComponentProps<"h2">) => (
    <h2 className="mb-2 text-sm font-bold text-[color:var(--text-primary)]" {...props} />
  ),
  h3: (props: ComponentProps<"h3">) => (
    <h3 className="mb-1.5 text-sm font-semibold text-[color:var(--text-primary)]" {...props} />
  ),
  ul: (props: ComponentProps<"ul">) => <ul className="mb-2 list-disc space-y-0.5 pl-4 text-sm" {...props} />,
  ol: (props: ComponentProps<"ol">) => <ol className="mb-2 list-decimal space-y-0.5 pl-4 text-sm" {...props} />,
  strong: (props: ComponentProps<"strong">) => (
    <strong className="font-semibold text-[color:var(--text-primary)]" {...props} />
  ),
  code: ({ className, ...props }: ComponentProps<"code">) =>
    className ? (
      <code
        className={`block overflow-x-auto border-2 border-[color:var(--border)] bg-[color:var(--bg-inset)] px-3 py-2 text-xs ${className}`}
        {...props}
      />
    ) : (
      <code
        className="bg-[color:var(--bg-inset)] px-1 py-0.5 text-[0.85em] text-[color:var(--text-primary)]"
        {...props}
      />
    ),
}

const Badge = ({
  children,
  tone = "neutral",
  compact,
}: {
  readonly children: ReactNode
  readonly tone?: "neutral" | "accent" | "warn" | "danger" | "success"
  readonly compact?: boolean
}) => {
  const colors =
    tone === "accent"
      ? "border-[color:var(--accent)]/30 bg-[color:var(--accent-muted)] text-[color:var(--accent)]"
      : tone === "danger"
        ? "border-[color:var(--danger)]/30 bg-[color:var(--danger-muted)] text-[color:var(--danger)]"
        : tone === "warn"
          ? "border-[color:var(--warn)]/30 bg-[color:var(--warn-muted)] text-[color:var(--warn)]"
          : tone === "success"
            ? "border-[color:var(--success)]/30 bg-[color:var(--success-muted)] text-[color:var(--success)]"
            : "border-[color:var(--border-strong)] bg-[color:var(--surface)] text-[color:var(--text-secondary)]"

  return (
    <span
      className={`inline-flex items-center border font-semibold uppercase tracking-wider ${compact ? "px-1.5 py-0.5 text-[0.6rem]" : "px-2 py-0.5 text-[0.65rem]"} ${colors}`}
    >
      {children}
    </span>
  )
}

const Collapsible = ({
  label,
  children,
  defaultOpen = false,
  count,
  className,
}: {
  readonly label: ReactNode
  readonly children: ReactNode
  readonly defaultOpen?: boolean
  readonly count?: number
  readonly className?: string
}) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={className}>
      <button
        className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)]"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        <Chevron open={open} />
        <span className="flex-1">{label}</span>
        {count !== undefined ? <span className="tabular-nums text-[color:var(--text-tertiary)]">{count}</span> : null}
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">{children}</div>
      </div>
    </div>
  )
}

const CollapsibleContent = ({
  content,
  maxLength = 140,
}: {
  readonly content: string
  readonly maxLength?: number
}) => {
  const [expanded, setExpanded] = useState(false)
  const isLong = content.length > maxLength

  return (
    <div className="text-sm leading-relaxed text-[color:var(--text-secondary)]">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {isLong && !expanded ? `${content.slice(0, maxLength)}...` : content}
      </ReactMarkdown>
      {isLong ? (
        <button
          className="mt-1 text-xs font-medium text-[color:var(--accent)] hover:text-[color:var(--accent-hover)]"
          onClick={() => setExpanded((prev) => !prev)}
          type="button"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  )
}

const DiffView = ({ patch }: { readonly patch: string }) => {
  const lines = patch.split("\n").map((raw, n) => ({ raw, n, kind: diffLineKind(raw) }))
  return (
    <pre className="overflow-x-auto border-2 border-[color:var(--border-strong)] bg-[color:var(--bg-inset)] text-[0.78rem] leading-5 p-0">
      <code>
        {lines.map((ln) => {
          const bg =
            ln.kind === "add"
              ? "bg-[color:var(--diff-add-bg)]"
              : ln.kind === "del"
                ? "bg-[color:var(--diff-del-bg)]"
                : ""
          const fg =
            ln.kind === "add"
              ? "text-[color:var(--diff-add-text)]"
              : ln.kind === "del"
                ? "text-[color:var(--diff-del-text)]"
                : ln.kind === "hunk"
                  ? "text-[color:var(--diff-hunk-text)]"
                  : ln.kind === "meta"
                    ? "text-[color:var(--text-tertiary)]"
                    : "text-[color:var(--text-secondary)]"
          return (
            <div className={`px-3 ${bg} ${fg}`} key={`${ln.kind}${ln.n}`}>
              {ln.raw || "\u00a0"}
            </div>
          )
        })}
      </code>
    </pre>
  )
}

// ── Verdict helpers ────────────────────────────────────────────

const verdictTone = (v: string | undefined) =>
  v === "pass" ? ("success" as const) : v === "fail" ? ("danger" as const) : ("warn" as const)

// ── Section: File list ─────────────────────────────────────────

const FileList = ({
  files,
  selected,
  onSelect,
}: {
  readonly files: ReadonlyArray<{ path: string }>
  readonly selected: string
  readonly onSelect: (path: string) => void
}) => (
  <div className="space-y-0.5">
    {files.map((file) => (
      <button
        className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors ${
          file.path === selected
            ? "bg-[color:var(--accent-muted)] text-[color:var(--accent)]"
            : "text-[color:var(--text-secondary)] hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--text-primary)]"
        }`}
        key={file.path}
        onClick={() => onSelect(file.path)}
        type="button"
      >
        <span className="flex-1 truncate font-mono">{shortPath(file.path)}</span>
      </button>
    ))}
  </div>
)

// ── Section: Findings ──────────────────────────────────────────

type Finding = NonNullable<SandboxCapture["review"]["result"]>["findings"][number]

const FindingCard = ({
  finding,
  isActive,
  onClick,
}: {
  readonly finding: Finding
  readonly isActive: boolean
  readonly onClick: () => void
}) => (
  <button
    className={`w-full text-left transition-colors border-2 p-2.5 ${
      isActive
        ? "border-[color:var(--accent)] bg-[color:var(--accent-muted)]"
        : "border-[color:var(--border)] hover:border-[color:var(--border-strong)]"
    }`}
    onClick={onClick}
    type="button"
  >
    <div className="flex items-center gap-1.5">
      <Badge compact tone={finding.severity === "high" || finding.severity === "critical" ? "danger" : "warn"}>
        {finding.severity}
      </Badge>
      <Badge compact>{finding.confidence}</Badge>
    </div>
    <p className="mt-1.5 text-xs font-semibold text-[color:var(--text-primary)]">{finding.title}</p>
    <p className="mt-0.5 font-mono text-[0.65rem] text-[color:var(--text-tertiary)]">
      {shortPath(finding.filePath)}:{finding.line}
    </p>
  </button>
)

// ── Section: Threads ───────────────────────────────────────────

const ThreadCard = ({
  thread,
  isActive,
  onClick,
}: {
  readonly thread: SandboxThread
  readonly isActive: boolean
  readonly onClick: () => void
}) => {
  const path = threadPath(thread)
  const isClosed = formatStatus(thread.status) === "Closed"

  return (
    <button
      className={`w-full text-left transition-colors border-2 p-2.5 ${
        isActive
          ? "border-[color:var(--accent)] bg-[color:var(--accent-muted)]"
          : "border-[color:var(--border)] hover:border-[color:var(--border-strong)]"
      }`}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${isClosed ? "bg-[color:var(--text-tertiary)]" : "bg-[color:var(--accent)]"}`}
          />
          <span className="text-xs font-medium text-[color:var(--text-primary)]">{path || "Summary"}</span>
        </div>
        <Badge compact tone={isClosed ? "neutral" : "accent"}>
          {formatStatus(thread.status)}
        </Badge>
      </div>
      <Collapsible
        className="mt-2"
        defaultOpen={!isClosed}
        label={
          <span className="text-[color:var(--text-tertiary)]">
            {thread.comments.length} comment{thread.comments.length !== 1 ? "s" : ""}
          </span>
        }
      >
        <div className="mt-1.5 space-y-2 pl-3 border-l border-[color:var(--border)]">
          {thread.comments.map((comment) => (
            <div key={comment.id}>
              <div className="flex items-center gap-2 text-[0.65rem] text-[color:var(--text-tertiary)]">
                <span className="font-medium">{comment.author?.displayName ?? "Unknown"}</span>
                <span>{formatDateTime(comment.publishedDate ?? undefined)}</span>
              </div>
              <CollapsibleContent content={comment.content ?? "No content."} maxLength={120} />
            </div>
          ))}
        </div>
      </Collapsible>
    </button>
  )
}

// ── Section: Actions ───────────────────────────────────────────

const ActionCard = ({ action }: { readonly action: SandboxCapture["review"]["actions"][number] }) => (
  <div className="border-2 border-[color:var(--border)] p-2.5">
    <div className="flex items-center gap-1.5">
      <Badge compact tone={action.type === "close-thread" ? "neutral" : "accent"}>
        {action.type}
      </Badge>
      {"existingThreadId" in action ? (
        <span className="text-[0.65rem] text-[color:var(--text-tertiary)]">#{action.existingThreadId}</span>
      ) : null}
    </div>
    {action.type !== "close-thread" && "content" in action ? (
      <CollapsibleContent content={action.content} maxLength={100} />
    ) : (
      <p className="mt-1.5 text-xs text-[color:var(--text-tertiary)]">Thread would be closed.</p>
    )}
  </div>
)

// ── App ────────────────────────────────────────────────────────

export const App = () => {
  const inputId = useId()
  const [capture, setCapture] = useState<SandboxCapture>(demoCapture)
  const [bottomTab, setBottomTab] = useState<BottomTab>("prompt")
  const [threadMode, setThreadMode] = useState<"before" | "after">("after")
  const [focus, setFocus] = useState<FocusTarget | undefined>(() => {
    const finding = demoCapture.review.result?.inlineFindings[0]
    return finding ? toFocusTarget(finding.filePath, finding.line) : undefined
  })
  const [error, setError] = useState<string | undefined>()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const threads = threadMode === "before" ? capture.baselineThreads : capture.review.previewThreads
  const selectedPath = focus?.path ?? capture.diff.files[0]?.path ?? ""
  const selectedFile = capture.diff.files.find((file) => file.path === selectedPath) ?? capture.diff.files[0]
  const selectedPatch = selectedFile?.patch ?? capture.diff.diffText
  const findings = capture.review.result?.findings ?? []
  const usage = capture.review.openCodeResult?.usage
  const tokens = usage?.tokens

  useEffect(() => {
    if (!selectedPath) return
    const element = document.getElementById(`diff-${CSS.escape(selectedPath)}`)
    if (element) element.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [selectedPath])

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "brutalist")
  }, [])

  const applyCapture = (candidate: unknown) => {
    try {
      const next = decodeCapture(candidate)
      startTransition(() => {
        setCapture(next)
        setError(undefined)
        const firstFinding = next.review.result?.inlineFindings[0]
        setFocus(firstFinding ? toFocusTarget(firstFinding.filePath, firstFinding.line) : undefined)
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
      setFocus(
        toFocusTarget(
          demoCapture.review.result?.inlineFindings[0]?.filePath ?? demoCapture.diff.files[0]?.path ?? "",
          demoCapture.review.result?.inlineFindings[0]?.line,
        ),
      )
    })
  }

  return (
    <div className="min-h-screen" data-theme="brutalist">
      {/* Top bar */}
      <nav className="sticky top-0 z-50 flex items-center justify-between gap-3 border-b-2 border-black bg-white/95 px-4 py-1.5 backdrop-blur">
        <span className="text-sm font-bold uppercase tracking-[0.25em]">Sandbox</span>
        <Badge tone={verdictTone(capture.review.result?.verdict)}>{capture.review.result?.verdict ?? "unknown"}</Badge>
      </nav>

      <div className="px-4 pb-8 pt-4">
        {/* Hero */}
        <header className="border-2 border-black bg-white p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-4xl font-normal leading-tight tracking-tight md:text-5xl">
                {capture.metadata.title}
              </h1>
              <div className="mt-3 flex flex-wrap gap-3 text-xs uppercase tracking-[0.2em]">
                <span>PR #{capture.target.pullRequestId}</span>
                <span className="text-[color:var(--accent)] font-bold">
                  {capture.review.result?.verdict ?? "unknown"}
                </span>
                <span>{capture.diff.files.length} files</span>
                <span>{capture.metadata.createdByDisplayName}</span>
                <span>{formatDateTime(capture.capturedAt)}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                className="border-2 border-black bg-black px-4 py-2 text-xs font-bold uppercase tracking-[0.15em] text-white transition hover:bg-[color:var(--accent)] hover:border-[color:var(--accent)]"
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                Import
              </button>
              <button
                className="border-2 border-black px-4 py-2 text-xs font-bold uppercase tracking-[0.15em] transition hover:bg-black hover:text-white"
                onClick={onReset}
                type="button"
              >
                Reset
              </button>
              <input
                accept="application/json"
                className="hidden"
                id={inputId}
                onChange={(event) => void onImportFile(event.target.files?.[0])}
                ref={fileInputRef}
                type="file"
              />
            </div>
          </div>
          {error ? (
            <p className="mt-3 border-2 border-[color:var(--danger)] bg-white p-2 text-xs text-[color:var(--danger)]">
              {error}
            </p>
          ) : null}
        </header>

        {/* Three columns */}
        <div className="mt-0 grid grid-cols-1 lg:grid-cols-[1fr_2fr_1fr]">
          {/* Left: Findings + Files + Stats */}
          <div className="border-2 border-t-0 border-black p-4 space-y-4">
            <h2 className="border-b-2 border-black pb-1 text-lg uppercase tracking-[0.15em]">Findings</h2>
            {findings.length > 0 ? (
              <div className="space-y-3">
                {findings.map((f) => (
                  <FindingCard
                    finding={f}
                    isActive={f.filePath === selectedPath}
                    key={`${f.filePath}:${f.line}`}
                    onClick={() => setFocus(toFocusTarget(f.filePath, f.line))}
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs">No findings.</p>
            )}

            <h2 className="border-b-2 border-black pb-1 text-lg uppercase tracking-[0.15em]">Files</h2>
            <FileList files={capture.diff.files} onSelect={(p) => setFocus({ path: p })} selected={selectedPath} />

            <h2 className="border-b-2 border-black pb-1 text-lg uppercase tracking-[0.15em]">Stats</h2>
            <div className="grid grid-cols-2 gap-2 text-xs uppercase">
              {(
                [
                  ["Files", capture.diff.files.length],
                  ["Actions", capture.review.actions.length],
                  ["Work Items", capture.workItems.length],
                  ["Threads", threads.length],
                ] as const
              ).map(([k, v]) => (
                <div className="border-2 border-black p-2" key={k}>
                  <span className="text-[color:var(--text-tertiary)]">{k}</span>
                  <strong className="block text-lg">{v}</strong>
                </div>
              ))}
            </div>

            {/* Cost & Tokens */}
            <h2 className="border-b-2 border-black pb-1 text-lg uppercase tracking-[0.15em]">Cost</h2>
            <div className="border-2 border-black p-3 space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-xs uppercase text-[color:var(--text-tertiary)]">Price</span>
                <span className="text-xl font-bold text-[color:var(--accent)]">
                  {usage?.costUsd !== undefined ? `$${usage.costUsd.toFixed(4)}` : "n/a"}
                </span>
              </div>
              {tokens ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs border-t-2 border-black pt-2">
                  <div className="flex justify-between">
                    <span className="text-[color:var(--text-tertiary)]">Input</span>
                    <span className="font-bold">{formatTokens(tokens.input)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[color:var(--text-tertiary)]">Output</span>
                    <span className="font-bold">{formatTokens(tokens.output)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[color:var(--text-tertiary)]">Reasoning</span>
                    <span className="font-bold">{formatTokens(tokens.reasoning)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[color:var(--text-tertiary)]">Cache Read</span>
                    <span className="font-bold">{formatTokens(tokens.cacheRead)}</span>
                  </div>
                  {tokens.cacheWrite > 0 ? (
                    <div className="flex justify-between">
                      <span className="text-[color:var(--text-tertiary)]">Cache Write</span>
                      <span className="font-bold">{formatTokens(tokens.cacheWrite)}</span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-[color:var(--text-tertiary)]">No token data.</p>
              )}
            </div>
          </div>

          {/* Center: Diff */}
          <div className="border-2 border-t-0 lg:border-l-0 border-black p-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg uppercase tracking-[0.15em]">{selectedFile?.path ?? "Diff"}</h2>
              <div className="flex flex-wrap gap-1">
                {(selectedFile?.changedLineRanges ?? []).map((r) => (
                  <button
                    className={`border-2 border-black px-2 py-0.5 text-[0.65rem] font-mono transition ${
                      focus?.line !== undefined && focus.line >= r.start && focus.line <= r.end
                        ? "bg-[color:var(--accent)] text-white border-[color:var(--accent)]"
                        : "hover:bg-black hover:text-white"
                    }`}
                    key={`${r.start}-${r.end}`}
                    onClick={() => setFocus({ path: selectedFile?.path ?? "", line: r.start })}
                    type="button"
                  >
                    L{r.start}
                    {r.end !== r.start ? `-${r.end}` : ""}
                  </button>
                ))}
              </div>
            </div>
            <DiffView patch={selectedPatch} />

            {/* Bottom: Prompt / Raw */}
            <div className="border-2 border-black">
              <div className="flex border-b-2 border-black">
                {(["prompt", "raw"] as const).map((tab) => (
                  <button
                    className={`flex-1 px-3 py-2 text-xs font-bold uppercase tracking-[0.15em] transition ${
                      bottomTab === tab ? "bg-black text-white" : "hover:bg-black/5"
                    } ${tab === "raw" ? "" : "border-r-2 border-black"}`}
                    key={tab}
                    onClick={() => setBottomTab(tab)}
                    type="button"
                  >
                    {tab === "raw" ? "Raw Output" : "Prompt"}
                  </button>
                ))}
              </div>
              <pre className="max-h-48 overflow-auto p-3 text-xs leading-5">
                <code>
                  {bottomTab === "prompt"
                    ? (capture.review.prompt ?? "No prompt captured.")
                    : (capture.review.openCodeResult?.response ?? "No raw output.")}
                </code>
              </pre>
            </div>
          </div>

          {/* Right: Threads + Actions */}
          <div className="border-2 border-t-0 lg:border-l-0 border-black p-4 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg uppercase tracking-[0.15em]">Threads</h2>
              <div className="flex border-2 border-black text-[0.6rem] font-bold uppercase">
                {(["before", "after"] as const).map((m) => (
                  <button
                    className={`px-2 py-1 transition ${
                      threadMode === m ? "bg-black text-white" : "hover:bg-black/5"
                    } ${m === "before" ? "border-r-2 border-black" : ""}`}
                    key={m}
                    onClick={() => setThreadMode(m)}
                    type="button"
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              {threads.map((t) => (
                <ThreadCard
                  isActive={threadPath(t) === selectedPath}
                  key={t.id}
                  onClick={() =>
                    setFocus(toFocusTarget(threadPath(t), t.threadContext?.rightFileStart?.line ?? undefined))
                  }
                  thread={t}
                />
              ))}
            </div>

            <h2 className="border-b-2 border-black pb-1 text-lg uppercase tracking-[0.15em]">Actions</h2>
            <div className="space-y-2">
              {capture.review.actions.map((a, i) => (
                <ActionCard action={a} key={`${a.type}-${i}`} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
