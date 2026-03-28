import { describe, expect, it } from "bun:test"

import { extractFenceLanguage } from "./pierre-markdown"

describe("extractFenceLanguage", () => {
  it("preserves hyphenated fenced languages", () => {
    expect(extractFenceLanguage("language-git-commit")).toBe("git-commit")
  })

  it("aliases gitignore to ini", () => {
    expect(extractFenceLanguage("language-gitignore")).toBe("ini")
  })

  it("falls back to text when no fence language exists", () => {
    expect(extractFenceLanguage(undefined)).toBe("text")
  })
})
