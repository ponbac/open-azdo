import { existsSync } from "node:fs"

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { extractFinalResponse, runOpenCode } from "../src/opencode"
import { makeReviewConfig } from "./helpers"

describe("opencode", () => {
  test("extracts the final JSON response from line-delimited events", () => {
    const output = [
      JSON.stringify({ text: "ignored prelude" }),
      JSON.stringify({
        content: [
          {
            text: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
          },
        ],
      }),
    ].join("\n")

    expect(extractFinalResponse(output)).toContain('"summary":"Summary"')
  })

  test("fails on empty output", () => {
    expect(() => extractFinalResponse("")).toThrow("OpenCode did not return a final response.")
  })

  test("cleans up temp config directories after a run", async () => {
    let configDir = ""

    const spawn = ((argv: string[], options?: { env?: Record<string, string> }) => {
      configDir = options?.env?.OPENCODE_CONFIG_DIR ?? ""
      expect(argv[0]).toBe("opencode")

      return {
        stdout: new Blob([
          JSON.stringify({
            text: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
          }),
        ]).stream(),
        stderr: new Blob([""]).stream(),
        exited: Promise.resolve(0),
      }
    }) as typeof Bun.spawn

    const result = await Effect.runPromise(runOpenCode(makeReviewConfig(), "prompt", spawn))

    expect(result).toContain('"summary":"Summary"')
    expect(configDir).not.toBe("")
    expect(existsSync(configDir)).toBe(false)
  })
})
