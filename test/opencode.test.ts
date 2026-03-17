import { existsSync } from "node:fs"

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { extractFinalResponse, runOpenCode } from "../src/opencode"
import { makeOpenCodeTestLayer, makeReviewConfig } from "./helpers"

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

  test("extracts the final response from OpenCode raw json events", () => {
    const output = [
      JSON.stringify({
        type: "step_start",
        timestamp: 1773751774585,
        sessionID: "ses_30427d661ffeOlnN5iZYsvbARB",
        part: {
          id: "prt_cfbd82d76001DlbMToMI154Vrz",
          sessionID: "ses_30427d661ffeOlnN5iZYsvbARB",
          messageID: "msg_cfbd82a0c001eivo5hX596tjMN",
          type: "step-start",
          snapshot: "5047b7d33fe0f338f7a45ece74a710d7dc4c884e",
        },
      }),
      JSON.stringify({
        type: "text",
        timestamp: 1773751778187,
        sessionID: "ses_30427d661ffeOlnN5iZYsvbARB",
        part: {
          id: "prt_cfbd83af8001cgVvBXN5I4M2WT",
          sessionID: "ses_30427d661ffeOlnN5iZYsvbARB",
          messageID: "msg_cfbd82a0c001eivo5hX596tjMN",
          type: "text",
          text: '{"summary":"ok","verdict":"pass","findings":[],"unmappedNotes":[]}',
          time: {
            start: 1773751778186,
            end: 1773751778186,
          },
          metadata: {
            openai: {
              itemId: "msg_0258bc4fb90d0de80169b94de2008c8191a83ee04a2491722a",
            },
          },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        timestamp: 1773751778226,
        sessionID: "ses_30427d661ffeOlnN5iZYsvbARB",
        part: {
          id: "prt_cfbd83ba20015HlTN2GdKMQR1R",
          sessionID: "ses_30427d661ffeOlnN5iZYsvbARB",
          messageID: "msg_cfbd82a0c001eivo5hX596tjMN",
          type: "step-finish",
          reason: "stop",
          snapshot: "5047b7d33fe0f338f7a45ece74a710d7dc4c884e",
          cost: 0,
        },
      }),
    ].join("\n")

    expect(extractFinalResponse(output)).toBe('{"summary":"ok","verdict":"pass","findings":[],"unmappedNotes":[]}')
  })

  test("fails on empty output", () => {
    expect(() => extractFinalResponse("")).toThrow("OpenCode did not return a final response.")
  })

  test("cleans up temp config directories after a run", async () => {
    let configDir = ""

    const result = await Effect.runPromise(
      runOpenCode(makeReviewConfig(), "prompt").pipe(
        Effect.provide(
          makeOpenCodeTestLayer({
            execute: (input) => {
              configDir = input.env?.OPENCODE_CONFIG_DIR ?? ""
              expect(input.command).toBe("opencode")

              return Effect.succeed({
                exitCode: 0,
                stdout: JSON.stringify({
                  text: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
                }),
                stderr: "",
              })
            },
          }),
        ),
      ),
    )

    expect(result).toContain('"summary":"Summary"')
    expect(configDir).not.toBe("")
    expect(existsSync(configDir)).toBe(false)
  })

  test("passes the configured timeout to the OpenCode process", async () => {
    let timeoutMs: number | undefined

    await Effect.runPromise(
      runOpenCode(makeReviewConfig({ opencodeTimeoutMs: 450_000 }), "prompt").pipe(
        Effect.provide(
          makeOpenCodeTestLayer({
            execute: (input) => {
              timeoutMs = input.timeoutMs

              return Effect.succeed({
                exitCode: 0,
                stdout: JSON.stringify({
                  text: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
                }),
                stderr: "",
              })
            },
          }),
        ),
      ),
    )

    expect(timeoutMs).toBe(450_000)
  })

  test("passes the configured OpenCode variant to the process", async () => {
    let args: ReadonlyArray<string> = []

    await Effect.runPromise(
      runOpenCode(makeReviewConfig({ opencodeVariant: "high" }), "prompt").pipe(
        Effect.provide(
          makeOpenCodeTestLayer({
            execute: (input) => {
              args = input.args

              return Effect.succeed({
                exitCode: 0,
                stdout: JSON.stringify({
                  text: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
                }),
                stderr: "",
              })
            },
          }),
        ),
      ),
    )

    expect(args).toContain("--variant")
    expect(args).toContain("high")
  })

  test("keeps the large review prompt out of the command-line arguments", async () => {
    let args: ReadonlyArray<string> = []
    const prompt = "review context ".repeat(20_000)

    await Effect.runPromise(
      runOpenCode(makeReviewConfig(), prompt).pipe(
        Effect.provide(
          makeOpenCodeTestLayer({
            execute: (input) => {
              args = input.args

              return Effect.succeed({
                exitCode: 0,
                stdout: JSON.stringify({
                  text: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
                }),
                stderr: "",
              })
            },
          }),
        ),
      ),
    )

    expect(args).not.toContain(prompt)
    expect(args.at(-1)).toBe("Review the pull request using your configured instructions and return strict JSON only.")
  })
})
