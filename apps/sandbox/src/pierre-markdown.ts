const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/

/**
 * Extract and normalize the language name from a fenced-code class.
 * Falls back to `text` and aliases `gitignore` to `ini` to match the
 * Pierre/t3code handling for Shiki's bundled grammars.
 */
export function extractFenceLanguage(className: string | undefined): string {
  const raw = className?.match(CODE_FENCE_LANGUAGE_REGEX)?.[1] ?? "text"
  return raw === "gitignore" ? "ini" : raw
}
