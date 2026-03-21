import { Effect } from "effect"
import TurndownService from "turndown"

const collapseBlankLines = (value: string) => value.replace(/\n{3,}/g, "\n\n")

const normalizeMarkdown = (value: string) => {
  const normalized = collapseBlankLines(
    value
      .replace(/\u00a0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, ""),
  )
  return normalized.trim().length > 0 ? normalized : undefined
}

const normalizeInput = (input: string | null | undefined) => (input ? normalizeMarkdown(input) : undefined)

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
})

turndown.remove(["script", "style", "img"])
turndown.addRule("azure-devops-anchor-text", {
  filter: "a",
  replacement(content) {
    return content
  },
})
turndown.addRule("azure-devops-media-elements", {
  filter(node) {
    return ["img", "svg", "picture", "source"].includes(node.nodeName.toLowerCase())
  },
  replacement() {
    return ""
  },
})

export const normalizeWorkItemMarkdown = Effect.fn("WorkItemMarkdown.normalize")(function* (
  input: string | null | undefined,
) {
  return yield* Effect.sync(() => normalizeInput(input))
})

export const renderWorkItemMarkdown = Effect.fn("WorkItemMarkdown.render")(function* (
  input: string | null | undefined,
) {
  const normalizedInput = normalizeInput(input)
  if (!normalizedInput) {
    return undefined
  }

  return yield* Effect.sync(() => {
    try {
      return normalizeMarkdown(turndown.turndown(normalizedInput))
    } catch {
      return undefined
    }
  })
})
