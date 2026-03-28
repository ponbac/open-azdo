/**
 * Observatory review workspace for the sandbox app.
 *
 * Muted warm-dark theme with amber/gold accents. Two-panel layout:
 * a compact sidebar for navigation and metrics, and a wide main area
 * for the selected content. High data density, compact typography.
 * Uses IBM Plex for a technical-but-warm feel.
 */
import { useState } from "react"

import { SandboxPatchDiff } from "./pierre"
import {
  type SandboxViewProps,
  type CaptureWorkItem,
  type PromptThread,
  CollapsibleText,
  HiddenFileInput,
  Markdown,
  filterReviewThreads,
  formatCost,
  formatDateTime,
  formatTokens,
  normalizePath,
  shortPath,
  threadPath,
  totalHistoryCost,
  totalHistoryTokens,
  useResolvedContext,
  verdictTone,
} from "./shared"

// ── Sub-components ─────────────────────────────────────────────

const Pill = ({
  children,
  tone = "neutral",
}: {
  readonly children: string
  readonly tone?: "neutral" | "success" | "warn" | "danger"
}) => {
  const colors =
    tone === "success"
      ? "bg-teal-800/40 text-teal-300 border-teal-700/50"
      : tone === "danger"
        ? "bg-rose-800/40 text-rose-300 border-rose-700/50"
        : tone === "warn"
          ? "bg-amber-800/40 text-amber-300 border-amber-700/50"
          : "bg-[#2a2520]/60 text-[#a09080] border-[#3a3530]"
  return (
    <span
      className={`inline-flex items-center border px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider ${colors}`}
    >
      {children}
    </span>
  )
}

type SidebarItem = "overview" | "findings" | "threads" | "context" | "history" | "prompt" | "files"

const SidebarNav = ({
  active,
  onSelect,
  counts,
}: {
  readonly active: SidebarItem
  readonly onSelect: (item: SidebarItem) => void
  readonly counts: Record<string, number>
}) => {
  const items: Array<{ readonly id: SidebarItem; readonly label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "findings", label: "Findings" },
    { id: "threads", label: "Threads" },
    { id: "context", label: "Context" },
    { id: "history", label: "History" },
    { id: "prompt", label: "Prompt" },
    { id: "files", label: "Files" },
  ]

  return (
    <nav className="space-y-0.5">
      {items.map((item) => (
        <button
          className={`flex w-full items-center justify-between px-3 py-2 text-[0.7rem] font-medium transition ${
            active === item.id
              ? "bg-amber-500/10 text-amber-400 border-l-2 border-amber-500 -ml-px"
              : "text-[#8a7e70] hover:text-[#c4b8a8] hover:bg-[#1e1a16]"
          }`}
          key={item.id}
          onClick={() => onSelect(item.id)}
          type="button"
        >
          <span>{item.label}</span>
          {counts[item.id] !== undefined ? (
            <span className="tabular-nums text-[0.6rem] opacity-60">{counts[item.id]}</span>
          ) : null}
        </button>
      ))}
    </nav>
  )
}

const StatRow = ({
  label,
  value,
  accent,
}: {
  readonly label: string
  readonly value: string
  readonly accent?: boolean
}) => (
  <div className="flex items-center justify-between py-1.5 border-b border-[#2a2520]/60 last:border-0">
    <span className="text-[0.65rem] text-[#8a7e70]">{label}</span>
    <span className={`text-[0.75rem] font-semibold tabular-nums ${accent ? "text-amber-400" : "text-[#c4b8a8]"}`}>
      {value}
    </span>
  </div>
)

const TokenRow = ({
  label,
  value,
  total,
  color,
}: {
  readonly label: string
  readonly value: number
  readonly total: number
  readonly color: string
}) => {
  const pct = total > 0 ? (value / total) * 100 : 0
  return (
    <div className="py-1">
      <div className="flex items-center justify-between text-[0.65rem] mb-0.5">
        <span className="text-[#8a7e70]">{label}</span>
        <span className="tabular-nums text-[#c4b8a8]">{formatTokens(value)}</span>
      </div>
      <div className="h-1 bg-[#1e1a16] overflow-hidden">
        <div className="h-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

// ── Content sections ───────────────────────────────────────────

const OverviewSection = ({ state }: SandboxViewProps) => {
  const { capture } = state
  const usage = capture.review.openCodeResult?.usage
  const tokens = usage?.tokens
  const history = capture.review.summaryState.reviewHistory ?? []
  const histCost = totalHistoryCost(history)
  const findings = capture.review.result?.findings ?? []
  const totalTokenCount = tokens ? tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead : 0
  const sc = capture.review.summaryState.severityCounts

  return (
    <div className="space-y-5">
      {/* Verdict + Summary */}
      <div className="border border-[#2a2520] bg-[#18140f] p-5">
        <div className="flex items-center gap-3 mb-3">
          <Pill tone={verdictTone(capture.review.result?.verdict)}>{capture.review.result?.verdict ?? "unknown"}</Pill>
          <span className="text-[0.6rem] text-[#8a7e70] uppercase tracking-wider">{capture.review.mode} review</span>
          <span className="text-[0.6rem] text-[#8a7e70]">{capture.review.resultSource ?? ""}</span>
        </div>
        {capture.review.result?.summary ? (
          <p className="text-sm leading-relaxed text-[#c4b8a8]">{capture.review.result.summary}</p>
        ) : null}
      </div>

      {/* Two-column: Cost + Severity */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-[#2a2520] bg-[#18140f] p-4">
          <div className="text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-[#8a7e70] mb-3">Cost</div>
          <StatRow accent label="This run" value={formatCost(usage?.costUsd)} />
          <StatRow label="Total spent" value={formatCost(histCost)} />
          <StatRow label="Reviews" value={String(history.length)} />
        </div>

        <div className="border border-[#2a2520] bg-[#18140f] p-4">
          <div className="text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-[#8a7e70] mb-3">
            Severity breakdown
          </div>
          <StatRow label="Critical" value={String(sc.critical)} />
          <StatRow label="High" value={String(sc.high)} />
          <StatRow label="Medium" value={String(sc.medium)} />
          <StatRow label="Low" value={String(sc.low)} />
          <StatRow accent label="Total findings" value={String(findings.length)} />
        </div>
      </div>

      {/* Tokens */}
      {tokens ? (
        <div className="border border-[#2a2520] bg-[#18140f] p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-[#8a7e70]">
              Tokens (this run)
            </span>
            <span className="text-xs tabular-nums text-[#c4b8a8]">{formatTokens(totalTokenCount)}</span>
          </div>
          <TokenRow color="#2dd4bf" label="Input" total={totalTokenCount} value={tokens.input} />
          <TokenRow color="#c084fc" label="Output" total={totalTokenCount} value={tokens.output} />
          <TokenRow color="#fb7185" label="Reasoning" total={totalTokenCount} value={tokens.reasoning} />
          <TokenRow color="#34d399" label="Cache Read" total={totalTokenCount} value={tokens.cacheRead} />
          {tokens.cacheWrite > 0 ? (
            <TokenRow color="#fbbf24" label="Cache Write" total={totalTokenCount} value={tokens.cacheWrite} />
          ) : null}
        </div>
      ) : null}

      {/* PR details */}
      <div className="border border-[#2a2520] bg-[#18140f] p-4">
        <div className="text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-[#8a7e70] mb-3">Pull request</div>
        <StatRow label="PR" value={`#${capture.target.pullRequestId}`} />
        <StatRow label="Author" value={capture.metadata.createdByDisplayName ?? "Unknown"} />
        <StatRow label="Source" value={capture.metadata.sourceRefName?.replace("refs/heads/", "") ?? "n/a"} />
        <StatRow label="Target" value={capture.metadata.targetRefName?.replace("refs/heads/", "") ?? "n/a"} />
        <StatRow label="Captured" value={formatDateTime(capture.capturedAt)} />
        <StatRow label="Files changed" value={String(capture.diff.files.length)} />
        <StatRow label="Actions" value={String(capture.review.actions.length)} />
      </div>
    </div>
  )
}

const FindingsSection = ({ state }: SandboxViewProps) => {
  const { capture } = state
  const findings = capture.review.result?.findings ?? []
  const [expanded, setExpanded] = useState<number>(-1)

  if (findings.length === 0) {
    return <div className="py-12 text-center text-[#8a7e70]">No findings produced.</div>
  }

  return (
    <div className="space-y-3">
      {findings.map((f, i) => {
        const diffFile = capture.diff.files.find((file) => file.path === f.filePath)
        const severityColor =
          f.severity === "critical"
            ? "border-l-rose-500"
            : f.severity === "high"
              ? "border-l-orange-500"
              : f.severity === "medium"
                ? "border-l-amber-500"
                : "border-l-teal-500"

        return (
          <div
            className={`border border-[#2a2520] border-l-2 ${severityColor} bg-[#18140f]`}
            key={`${f.filePath}:${f.line}`}
          >
            <button
              className="flex w-full items-start gap-3 p-4 text-left hover:bg-white/[0.02] transition"
              onClick={() => setExpanded(expanded === i ? -1 : i)}
              type="button"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Pill tone={f.severity === "critical" || f.severity === "high" ? "danger" : "warn"}>
                    {f.severity}
                  </Pill>
                  <Pill>{f.confidence}</Pill>
                </div>
                <h3 className="mt-2 text-sm font-semibold text-[#e4d8c8] leading-snug">{f.title}</h3>
                <div className="mt-1 text-[0.65rem] text-[#8a7e70] font-mono">
                  {shortPath(f.filePath)}:{f.line}
                  {f.endLine ? `-${f.endLine}` : ""}
                </div>
              </div>
            </button>

            {expanded === i ? (
              <div className="border-t border-[#2a2520] p-4 space-y-3">
                <div className="text-sm text-[#a09080] leading-relaxed">
                  <Markdown>{f.body}</Markdown>
                </div>

                {f.suggestion ? (
                  <div className="border border-amber-700/30 bg-amber-900/10 p-3">
                    <div className="text-[0.6rem] font-semibold uppercase tracking-wider text-amber-500 mb-1">
                      Suggestion
                    </div>
                    <div className="text-sm text-[#c4b8a8]">
                      <Markdown>{f.suggestion}</Markdown>
                    </div>
                  </div>
                ) : null}

                {diffFile?.patch ? <SandboxPatchDiff patch={diffFile.patch} /> : null}
              </div>
            ) : null}
          </div>
        )
      })}

      {/* Actions */}
      <div className="border border-[#2a2520] bg-[#18140f] p-4 mt-4">
        <div className="text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-[#8a7e70] mb-3">
          Actions ({capture.review.actions.length})
        </div>
        <div className="flex flex-wrap gap-1.5">
          {capture.review.actions.map((a, i) => {
            const key =
              a.type === "close-thread"
                ? `close-${a.existingThreadId}`
                : `${a.type}-${"existingThreadId" in a ? a.existingThreadId : `new-${i}`}`
            return (
              <span
                className={`px-2 py-0.5 text-[0.6rem] font-mono border ${
                  a.type === "close-thread"
                    ? "border-[#2a2520] text-[#6a6050]"
                    : a.type === "upsert-summary"
                      ? "border-amber-700/40 text-amber-400"
                      : "border-teal-700/40 text-teal-400"
                }`}
                key={key}
              >
                {a.type === "close-thread" ? "close" : a.type === "upsert-summary" ? "summary" : "finding"}
                {"existingThreadId" in a ? ` #${a.existingThreadId}` : ""}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const ThreadsSection = ({ state }: SandboxViewProps) => {
  const { capture } = state
  const [threadMode, setThreadMode] = useState<"before" | "after">("after")
  const rawThreads = threadMode === "before" ? capture.baselineThreads : capture.review.previewThreads
  const threads = filterReviewThreads(rawThreads)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-4">
        {(["before", "after"] as const).map((m) => (
          <button
            className={`px-3 py-1.5 text-[0.6rem] font-semibold uppercase tracking-wider border transition ${
              threadMode === m
                ? "border-amber-600/50 bg-amber-600/10 text-amber-400"
                : "border-[#2a2520] text-[#8a7e70] hover:text-[#c4b8a8]"
            }`}
            key={m}
            onClick={() => setThreadMode(m)}
            type="button"
          >
            {m}
          </button>
        ))}
        <span className="text-[0.6rem] text-[#6a6050] ml-2">
          {threads.length} of {rawThreads.length}
        </span>
      </div>

      {threads.map((t) => {
        const path = threadPath(t)
        const isClosed = t.status === 2 || t.status === "fixed" || t.status === "closed"
        return (
          <div className={`border border-[#2a2520] bg-[#18140f] p-3 ${isClosed ? "opacity-40" : ""}`} key={t.id}>
            <div className="flex items-center gap-2 mb-2">
              <span className={`h-1.5 w-1.5 rounded-full ${isClosed ? "bg-[#4a4440]" : "bg-amber-500"}`} />
              <span className="text-xs font-medium text-[#e4d8c8] truncate">{path || "Summary"}</span>
              {t.threadContext?.rightFileStart?.line ? (
                <span className="text-[0.6rem] text-[#6a6050] font-mono">L{t.threadContext.rightFileStart.line}</span>
              ) : null}
            </div>
            <div className="pl-3 border-l border-[#2a2520] space-y-2">
              {t.comments.map((c) => (
                <div key={c.id}>
                  <div className="flex items-center gap-2 text-[0.6rem] text-[#6a6050]">
                    <span className="font-medium">{c.author?.displayName ?? "Unknown"}</span>
                    <span>{formatDateTime(c.publishedDate ?? undefined)}</span>
                  </div>
                  <CollapsibleText
                    className="text-xs text-[#a09080] mt-0.5"
                    content={c.content ?? "No content."}
                    maxLength={180}
                  />
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const HistorySection = ({ state }: SandboxViewProps) => {
  const { capture } = state
  const history = capture.review.summaryState.reviewHistory ?? []

  if (history.length === 0) {
    return <div className="py-12 text-center text-[#8a7e70]">No review history.</div>
  }

  const histCost = totalHistoryCost(history)
  const histTokens = totalHistoryTokens(history)
  const histTotal = histTokens.input + histTokens.output + histTokens.reasoning + histTokens.cacheRead

  return (
    <div className="space-y-4">
      {/* Cumulative stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="border border-[#2a2520] bg-[#18140f] p-3">
          <div className="text-[0.6rem] text-[#8a7e70] uppercase">Total cost</div>
          <div className="text-lg font-light tabular-nums text-amber-400 mt-0.5">{formatCost(histCost)}</div>
        </div>
        <div className="border border-[#2a2520] bg-[#18140f] p-3">
          <div className="text-[0.6rem] text-[#8a7e70] uppercase">Total tokens</div>
          <div className="text-lg font-light tabular-nums text-[#c4b8a8] mt-0.5">{formatTokens(histTotal)}</div>
        </div>
        <div className="border border-[#2a2520] bg-[#18140f] p-3">
          <div className="text-[0.6rem] text-[#8a7e70] uppercase">Runs</div>
          <div className="text-lg font-light tabular-nums text-[#c4b8a8] mt-0.5">{history.length}</div>
        </div>
      </div>

      {/* Timeline */}
      <div className="border border-[#2a2520] bg-[#18140f] overflow-hidden">
        {history.map((h, i) => (
          <div
            className="flex items-center gap-3 px-4 py-2.5 text-[0.7rem] border-b border-[#2a2520] last:border-0 hover:bg-white/[0.01]"
            key={`${h.reviewedCommit}-${i}`}
          >
            <span className="w-28 shrink-0 tabular-nums text-[#8a7e70]">{formatDateTime(h.reviewedAt)}</span>
            <Pill tone={h.reviewMode === "follow-up" ? "warn" : "neutral"}>{h.reviewMode}</Pill>
            <span className="flex-1 font-mono text-[0.65rem] text-[#6a6050] truncate">{h.model}</span>
            <span className="shrink-0 tabular-nums text-[#c4b8a8] font-semibold">{formatCost(h.costUsd)}</span>
            <span className="shrink-0 w-14 text-right tabular-nums text-[#6a6050]">
              {h.tokens
                ? formatTokens(h.tokens.input + h.tokens.output + h.tokens.reasoning + h.tokens.cacheRead)
                : "n/a"}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

const PromptSection = ({ state }: SandboxViewProps) => {
  const { capture } = state
  const [showRaw, setShowRaw] = useState(false)

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          className={`px-3 py-1.5 text-[0.6rem] font-semibold uppercase tracking-wider border transition ${
            !showRaw ? "border-amber-600/50 bg-amber-600/10 text-amber-400" : "border-[#2a2520] text-[#8a7e70]"
          }`}
          onClick={() => setShowRaw(false)}
          type="button"
        >
          Prompt
        </button>
        <button
          className={`px-3 py-1.5 text-[0.6rem] font-semibold uppercase tracking-wider border transition ${
            showRaw ? "border-amber-600/50 bg-amber-600/10 text-amber-400" : "border-[#2a2520] text-[#8a7e70]"
          }`}
          onClick={() => setShowRaw(true)}
          type="button"
        >
          Raw output
        </button>
      </div>

      <pre className="bg-[#0f0c0a] border border-[#2a2520] p-4 text-xs leading-5 text-[#a09080] whitespace-pre-wrap overflow-y-auto max-h-[60vh]">
        {showRaw
          ? (capture.review.openCodeResult?.response ?? "No raw output.")
          : (capture.review.prompt ?? "No prompt captured.")}
      </pre>
    </div>
  )
}

const FilesSection = ({ state }: SandboxViewProps) => {
  const { capture } = state
  const [selectedFile, setSelectedFile] = useState<string | undefined>()

  const file = capture.diff.files.find((f) => f.path === selectedFile)

  return (
    <div className="space-y-3">
      <div className="text-[0.6rem] text-[#8a7e70] uppercase">{capture.diff.files.length} files changed</div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-3">
        {/* File list */}
        <div className="border border-[#2a2520] bg-[#18140f] max-h-[60vh] overflow-y-auto">
          {capture.diff.files.map((f) => (
            <button
              className={`flex w-full items-center px-3 py-1.5 text-left text-[0.7rem] font-mono transition border-b border-[#2a2520] last:border-0 ${
                selectedFile === f.path
                  ? "bg-amber-500/10 text-amber-400"
                  : "text-[#8a7e70] hover:text-[#c4b8a8] hover:bg-[#1e1a16]"
              }`}
              key={f.path}
              onClick={() => setSelectedFile(f.path)}
              type="button"
            >
              <span className="truncate">{shortPath(f.path)}</span>
            </button>
          ))}
        </div>

        {/* Diff */}
        <div>
          {file ? (
            <div>
              <div className="text-xs font-mono text-[#8a7e70] mb-2 truncate">{file.path}</div>
              <SandboxPatchDiff patch={file.patch} />
            </div>
          ) : (
            <div className="border border-[#2a2520] bg-[#18140f] p-8 text-center text-[#6a6050] text-sm">
              Select a file to view its diff.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Context section ────────────────────────────────────────────

/** Warm-dark card for a connected work item in Observatory style. */
const ObservatoryWorkItem = ({ workItem }: { readonly workItem: CaptureWorkItem }) => {
  const [expanded, setExpanded] = useState(false)
  const hasDetails = workItem.descriptionMarkdown || workItem.acceptanceCriteriaMarkdown || workItem.reproStepsMarkdown
  const hasComments = workItem.recentComments.length > 0

  return (
    <div className="border border-[#2a2520] bg-[#18140f] p-3">
      <button
        className="flex w-full items-start gap-3 text-left group"
        onClick={() => setExpanded((p) => !p)}
        type="button"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Pill tone="warn">{workItem.workItemType}</Pill>
            <span className="text-[0.6rem] text-[#6a6050]">#{workItem.id}</span>
            <Pill
              tone={
                workItem.state === "Active" || workItem.state === "Committed"
                  ? "success"
                  : workItem.state === "Closed" || workItem.state === "Done" || workItem.state === "Resolved"
                    ? "neutral"
                    : "warn"
              }
            >
              {workItem.state}
            </Pill>
            {workItem.priority ? <span className="text-[0.55rem] text-[#8a7e70]">P{workItem.priority}</span> : null}
          </div>
          <h4 className="mt-1.5 text-sm font-semibold text-[#e4d8c8] leading-snug group-hover:text-amber-300 transition-colors">
            {workItem.title}
          </h4>
          {workItem.assignedTo || workItem.tags.length > 0 ? (
            <div className="mt-1 flex items-center gap-2 text-[0.6rem] text-[#6a6050]">
              {workItem.assignedTo ? <span>{workItem.assignedTo}</span> : null}
              {workItem.tags.length > 0 ? <span>{workItem.tags.join(", ")}</span> : null}
            </div>
          ) : null}
        </div>
        {hasDetails || hasComments ? (
          <svg
            aria-hidden="true"
            className={`shrink-0 h-3.5 w-3.5 text-[#6a6050] transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <title>Toggle</title>
            <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </button>

      {expanded ? (
        <div className="mt-3 pt-3 border-t border-[#2a2520] space-y-2">
          {workItem.descriptionMarkdown ? (
            <div>
              <div className="text-[0.6rem] font-semibold uppercase tracking-wider text-[#6a6050] mb-1">
                Description
              </div>
              <CollapsibleText
                className="text-xs text-[#a09080]"
                content={workItem.descriptionMarkdown}
                maxLength={300}
              />
            </div>
          ) : null}
          {workItem.acceptanceCriteriaMarkdown ? (
            <div>
              <div className="text-[0.6rem] font-semibold uppercase tracking-wider text-[#6a6050] mb-1">
                Acceptance criteria
              </div>
              <CollapsibleText
                className="text-xs text-[#a09080]"
                content={workItem.acceptanceCriteriaMarkdown}
                maxLength={300}
              />
            </div>
          ) : null}
          {workItem.reproStepsMarkdown ? (
            <div>
              <div className="text-[0.6rem] font-semibold uppercase tracking-wider text-[#6a6050] mb-1">
                Repro steps
              </div>
              <CollapsibleText
                className="text-xs text-[#a09080]"
                content={workItem.reproStepsMarkdown}
                maxLength={300}
              />
            </div>
          ) : null}
          {workItem.related.length > 0 ? (
            <div className="text-[0.6rem] text-[#6a6050]">
              Related: {workItem.related.map((r) => `#${r.id}${r.title ? ` ${r.title}` : ""}`).join(", ")}
            </div>
          ) : null}
          {hasComments ? (
            <div>
              <div className="text-[0.6rem] font-semibold uppercase tracking-wider text-[#6a6050] mb-1">
                Recent comments
              </div>
              <div className="space-y-1.5 pl-2 border-l border-[#2a2520]">
                {workItem.recentComments.map((c, i) => (
                  <div key={`${c.author}-${i}`}>
                    <div className="flex items-center gap-2 text-[0.6rem] text-[#6a6050]">
                      <span className="font-medium">{c.author}</span>
                      <span>{formatDateTime(c.createdAt)}</span>
                    </div>
                    <CollapsibleText className="text-xs text-[#a09080] mt-0.5" content={c.markdown} maxLength={200} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Warm-dark card for a prompt thread in Observatory style. */
const ObservatoryPromptThread = ({ thread }: { readonly thread: PromptThread }) => {
  const filePath = thread.filePath ? normalizePath(thread.filePath) : undefined

  return (
    <div className="border border-[#2a2520] bg-[#18140f] p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className={`h-1.5 w-1.5 rounded-full ${thread.managedThread ? "bg-amber-500" : "bg-teal-400"}`} />
        <span className="text-xs font-medium text-[#e4d8c8] truncate">
          {filePath ? shortPath(filePath) : "General thread"}
        </span>
        {thread.line ? <span className="text-[0.6rem] text-[#6a6050] font-mono">L{thread.line}</span> : null}
        <span className="text-[0.55rem] text-[#6a6050]">#{thread.id}</span>
        {thread.managedThread ? <Pill tone="warn">managed</Pill> : null}
      </div>
      <div className="space-y-1.5 pl-2 border-l border-[#2a2520]">
        {thread.comments.map((c, i) => (
          <div key={`${c.author}-${i}`}>
            <div className="flex items-center gap-2 text-[0.6rem] text-[#6a6050]">
              <span className={`font-medium ${c.origin === "open-azdo" ? "text-amber-500/70" : "text-[#a09080]"}`}>
                {c.author}
              </span>
              {c.publishedAt ? <span>{formatDateTime(c.publishedAt)}</span> : null}
              {c.origin === "open-azdo" ? <span className="text-amber-500/40 text-[0.5rem]">bot</span> : null}
            </div>
            <CollapsibleText className="text-xs text-[#a09080] mt-0.5" content={c.content} maxLength={180} />
          </div>
        ))}
      </div>
    </div>
  )
}

const ContextSection = ({ state }: SandboxViewProps) => {
  const { capture } = state
  const ctx = useResolvedContext(capture)
  const promptThreads = ctx.promptThreads ?? []

  const hasWorkItems = ctx.workItems.length > 0
  const hasThreads = promptThreads.length > 0

  if (!hasWorkItems && !hasThreads) {
    return <div className="py-12 text-center text-[#8a7e70]">No work items or prompt threads available.</div>
  }

  return (
    <div className="space-y-5">
      {/* Work items */}
      {hasWorkItems ? (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-[#8a7e70]">
              Connected work items ({ctx.workItems.length})
            </span>
            <div className="flex items-center gap-2">
              {ctx.workItemsOmittedCount > 0 ? (
                <span className="text-[0.55rem] text-amber-500">{ctx.workItemsOmittedCount} omitted from prompt</span>
              ) : null}
              {!ctx.workItemsFromPrompt ? (
                <span className="text-[0.55rem] text-[#6a6050] italic">from capture</span>
              ) : null}
            </div>
          </div>
          <div className="space-y-3">
            {ctx.workItems.map((wi) => (
              <ObservatoryWorkItem key={wi.id} workItem={wi} />
            ))}
          </div>
        </div>
      ) : null}

      {/* Prompt threads */}
      {hasThreads ? (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-[#8a7e70]">
              Threads in prompt ({promptThreads.length})
            </span>
            {ctx.threadsOmittedCount > 0 ? (
              <span className="text-[0.55rem] text-amber-500">{ctx.threadsOmittedCount} omitted (budget)</span>
            ) : null}
          </div>
          <div className="space-y-3">
            {promptThreads.map((pt) => (
              <ObservatoryPromptThread key={pt.id} thread={pt} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── Main layout ────────────────────────────────────────────────

export const Observatory = ({ state }: SandboxViewProps) => {
  const { capture, error, fileInputRef, inputId, onImportFile, onReset } = state
  const [activeItem, setActiveItem] = useState<SidebarItem>("overview")

  const findings = capture.review.result?.findings ?? []
  const rawThreads = capture.review.previewThreads ?? []
  const threads = filterReviewThreads(rawThreads)
  const history = capture.review.summaryState.reviewHistory ?? []
  const ctx = useResolvedContext(capture)

  const contextCount = ctx.workItems.length + (ctx.promptThreads?.length ?? 0)

  const counts: Record<string, number> = {
    findings: findings.length,
    threads: threads.length,
    context: contextCount,
    history: history.length,
    files: capture.diff.files.length,
  }

  return (
    <div
      className="min-h-screen bg-[#141210] text-[#a09080]"
      style={{ fontFamily: "'IBM Plex Mono', 'JetBrains Mono', monospace" }}
    >
      {/* Top bar */}
      <nav className="sticky top-0 z-50 flex items-center justify-between gap-3 border-b border-[#2a2520] bg-[#141210]/95 px-4 py-2 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <span className="text-[0.6rem] font-semibold uppercase tracking-[0.3em] text-amber-600">Observatory</span>
          <span className="text-[0.6rem] text-[#3a3530]">|</span>
          <span className="text-xs text-[#c4b8a8] truncate max-w-sm">{capture.metadata.title}</span>
          <Pill tone={verdictTone(capture.review.result?.verdict)}>{capture.review.result?.verdict ?? "unknown"}</Pill>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="px-3 py-1.5 text-[0.6rem] font-semibold uppercase tracking-wider text-amber-500 border border-[#2a2520] hover:bg-amber-500/10 hover:border-amber-600/30 transition"
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            Import
          </button>
          <button
            className="px-3 py-1.5 text-[0.6rem] font-semibold uppercase tracking-wider text-[#6a6050] border border-[#2a2520] hover:bg-white/5 transition"
            onClick={onReset}
            type="button"
          >
            Reset
          </button>
          <HiddenFileInput fileInputRef={fileInputRef} inputId={inputId} onImportFile={onImportFile} />
        </div>
      </nav>

      {error ? (
        <div className="mx-4 mt-3 border border-rose-700/30 bg-rose-900/10 p-3 text-xs text-rose-400">{error}</div>
      ) : null}

      {/* Two-panel layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] min-h-[calc(100vh-45px)]">
        {/* Sidebar */}
        <aside className="border-r border-[#2a2520] pt-4 pb-8">
          {/* Quick stats */}
          <div className="px-3 mb-4 space-y-1">
            <div className="flex items-center justify-between text-[0.6rem]">
              <span className="text-[#6a6050]">Cost</span>
              <span className="font-semibold text-amber-400 tabular-nums">
                {formatCost(capture.review.openCodeResult?.usage?.costUsd)}
              </span>
            </div>
            <div className="flex items-center justify-between text-[0.6rem]">
              <span className="text-[#6a6050]">PR</span>
              <span className="text-[#c4b8a8]">#{capture.target.pullRequestId}</span>
            </div>
          </div>

          <div className="border-t border-[#2a2520] pt-2">
            <SidebarNav active={activeItem} counts={counts} onSelect={setActiveItem} />
          </div>
        </aside>

        {/* Main content */}
        <main className="p-5 overflow-y-auto">
          {activeItem === "overview" ? <OverviewSection state={state} /> : null}
          {activeItem === "findings" ? <FindingsSection state={state} /> : null}
          {activeItem === "threads" ? <ThreadsSection state={state} /> : null}
          {activeItem === "context" ? <ContextSection state={state} /> : null}
          {activeItem === "history" ? <HistorySection state={state} /> : null}
          {activeItem === "prompt" ? <PromptSection state={state} /> : null}
          {activeItem === "files" ? <FilesSection state={state} /> : null}
        </main>
      </div>
    </div>
  )
}
