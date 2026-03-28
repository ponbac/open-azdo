import { getSharedHighlighter, type DiffsHighlighter, type SupportedLanguages } from "@pierre/diffs"
import { PatchDiff, type PatchDiffProps, WorkerPoolContextProvider } from "@pierre/diffs/react"
// oxlint-disable-next-line import/default
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker"
import { Children, isValidElement, useEffect, useMemo, useState, type ReactNode } from "react"
import type { Components } from "react-markdown"

import { extractFenceLanguage } from "./pierre-markdown"

const SANDBOX_THEME = "pierre-dark" as const
const TOTAL_AST_LRU_CACHE_SIZE = 240
const TOKENIZE_MAX_LINE_LENGTH = 1_000

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>()
const highlightedCodeCache = new Map<string, string>()
const pendingHighlightedCodeCache = new Map<string, Promise<string>>()

const SANDBOX_PATCH_OPTIONS = {
  theme: SANDBOX_THEME,
  themeType: "dark",
  diffStyle: "unified",
  lineDiffType: "none",
  disableFileHeader: true,
  lineHoverHighlight: "disabled",
  enableGutterUtility: false,
} satisfies NonNullable<PatchDiffProps<undefined>["options"]>

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("")
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children)
  }
  return ""
}

function extractCodeBlock(
  children: ReactNode,
): { readonly className: string | undefined; readonly code: string } | null {
  const childNodes = Children.toArray(children)
  if (childNodes.length !== 1) {
    return null
  }

  const onlyChild = childNodes[0]
  if (!isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) || onlyChild.type !== "code") {
    return null
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  }
}

function getSandboxWorkerPoolSize(): number {
  const cores = typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4)
  return Math.max(2, Math.min(6, Math.floor(cores / 2)))
}

function createHighlightCacheKey(code: string, language: string): string {
  return `${language}:${code.length}:${code}`
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language)
  if (cached) {
    return cached
  }

  const promise = (async () => {
    try {
      return await getSharedHighlighter({
        themes: [SANDBOX_THEME],
        langs: [language as SupportedLanguages],
        preferredHighlighter: "shiki-js",
      })
    } catch (error) {
      highlighterPromiseCache.delete(language)
      if (language === "text") {
        throw error
      }
      return getHighlighterPromise("text")
    }
  })()

  highlighterPromiseCache.set(language, promise)
  return promise
}

/**
 * Highlight a markdown code fence with the shared Pierre/Shiki highlighter.
 * The promise cache avoids duplicate work when identical fences re-render
 * during sandbox navigation or expansion.
 */
async function renderHighlightedCode(code: string, language: string): Promise<string> {
  const cacheKey = createHighlightCacheKey(code, language)
  const cachedHtml = highlightedCodeCache.get(cacheKey)
  if (cachedHtml) {
    return cachedHtml
  }

  let pending = pendingHighlightedCodeCache.get(cacheKey)
  if (!pending) {
    pending = (async () => {
      const highlighter = await getHighlighterPromise(language)

      try {
        return highlighter.codeToHtml(code, {
          lang: language as SupportedLanguages,
          theme: SANDBOX_THEME,
        })
      } catch {
        // Unsupported grammars fall back to plain text while still using the
        // Pierre theme, which is better than dropping syntax highlighting.
        return highlighter.codeToHtml(code, {
          lang: "text",
          theme: SANDBOX_THEME,
        })
      }
    })()

    pendingHighlightedCodeCache.set(cacheKey, pending)
  }

  try {
    const html = await pending
    highlightedCodeCache.set(cacheKey, html)
    return html
  } finally {
    pendingHighlightedCodeCache.delete(cacheKey)
  }
}

function MarkdownCodeBlock({
  className,
  code,
  fallback,
}: {
  readonly className: string | undefined
  readonly code: string
  readonly fallback: ReactNode
}) {
  const language = extractFenceLanguage(className)
  const cacheKey = useMemo(() => createHighlightCacheKey(code, language), [code, language])
  const [highlightedHtml, setHighlightedHtml] = useState<string | undefined>(() => highlightedCodeCache.get(cacheKey))

  useEffect(() => {
    let cancelled = false

    const cachedHtml = highlightedCodeCache.get(cacheKey)
    if (cachedHtml) {
      setHighlightedHtml(cachedHtml)
      return () => {
        cancelled = true
      }
    }

    setHighlightedHtml(undefined)

    const loadHighlightedHtml = async () => {
      try {
        const html = await renderHighlightedCode(code, language)
        if (!cancelled) {
          setHighlightedHtml(html)
        }
      } catch {
        if (!cancelled) {
          setHighlightedHtml(undefined)
        }
      }
    }

    void loadHighlightedHtml()

    return () => {
      cancelled = true
    }
  }, [cacheKey, code, language])

  if (!highlightedHtml) {
    return fallback
  }

  return <div className="observatory-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
}

/**
 * Provide the shared Pierre worker pool for sandbox diff rendering.
 * The sandbox is dark-only for now, so the worker render options are fixed.
 */
export const SandboxDiffProvider = ({ children }: { readonly children: ReactNode }) => {
  const workerPoolSize = useMemo(() => getSandboxWorkerPoolSize(), [])

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => new DiffsWorker(),
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: TOTAL_AST_LRU_CACHE_SIZE,
      }}
      highlighterOptions={{
        theme: SANDBOX_THEME,
        tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
      }}
    >
      {children}
    </WorkerPoolContextProvider>
  )
}

/**
 * Sandbox wrapper for Pierre's unified patch renderer.
 * The file header stays disabled because Observatory already renders the
 * selected file identity around the diff surface.
 */
export const SandboxPatchDiff = ({ patch, className }: { readonly patch: string; readonly className?: string }) => (
  <PatchDiff
    className={className ? `observatory-pierre-diff ${className}` : "observatory-pierre-diff"}
    options={SANDBOX_PATCH_OPTIONS}
    patch={patch}
  />
)

/**
 * React-markdown component overrides that route fenced code blocks through
 * the shared Pierre highlighter while leaving non-code markdown untouched.
 */
export function useMarkdownComponents(): Components {
  return useMemo(
    () => ({
      pre({ children, ...props }) {
        const codeBlock = extractCodeBlock(children)
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>
        }

        const fallback = (
          <pre className="observatory-markdown-fallback" {...props}>
            {children}
          </pre>
        )

        return <MarkdownCodeBlock className={codeBlock.className} code={codeBlock.code} fallback={fallback} />
      },
    }),
    [],
  )
}
