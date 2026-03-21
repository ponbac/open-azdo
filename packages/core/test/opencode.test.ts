import { existsSync } from "node:fs"

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Duration from "effect/Duration"

import { OpenCodeRunner, extractFinalResponse, extractOpenCodeRunResult } from "@open-azdo/core/opencode"
import { makeOpenCodeLiveLayer, makeOpenCodeRunRequest, makeProcessRunner, withSilentLogs } from "./helpers"

const runOpenCode = (
  request = makeOpenCodeRunRequest(),
  runner = makeProcessRunner(() => Effect.die("runner not configured")),
) =>
  Effect.gen(function* () {
    const service = yield* OpenCodeRunner
    return yield* service.run(request)
  }).pipe(Effect.provide(makeOpenCodeLiveLayer(runner)), withSilentLogs)

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
        },
      }),
    ].join("\n")

    expect(extractFinalResponse(output)).toBe('{"summary":"ok","verdict":"pass","findings":[],"unmappedNotes":[]}')
  })

  test("extracts usage metadata from a step-finish part", () => {
    const output = [
      JSON.stringify({
        type: "message.part.updated",
        sessionID: "ses_usage",
        part: {
          id: "prt_finish",
          sessionID: "ses_usage",
          messageID: "msg_usage",
          type: "step-finish",
          cost: 0.1234,
          tokens: {
            input: 1200,
            output: 345,
            reasoning: 67,
            cacheRead: 890,
            cacheWrite: 12,
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_usage",
        part: {
          id: "prt_text",
          sessionID: "ses_usage",
          messageID: "msg_usage",
          type: "text",
          text: '{"summary":"ok","verdict":"pass","findings":[],"unmappedNotes":[]}',
        },
      }),
    ].join("\n")

    expect(extractOpenCodeRunResult(output)).toEqual({
      response: '{"summary":"ok","verdict":"pass","findings":[],"unmappedNotes":[]}',
      sessionId: "ses_usage",
      usage: {
        costUsd: 0.1234,
        tokens: {
          input: 1200,
          output: 345,
          reasoning: 67,
          cacheRead: 890,
          cacheWrite: 12,
        },
      },
    })
  })

  test("falls back to assistant info usage when no step-finish part is present", () => {
    const output = [
      JSON.stringify({
        type: "message.updated",
        sessionID: "ses_assistant",
        info: {
          role: "assistant",
          cost: 0.0456,
          tokens: {
            input: 900,
            output: 120,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
        text: '{"summary":"ok","verdict":"pass","findings":[],"unmappedNotes":[]}',
      }),
    ].join("\n")

    expect(extractOpenCodeRunResult(output)).toEqual({
      response: '{"summary":"ok","verdict":"pass","findings":[],"unmappedNotes":[]}',
      sessionId: "ses_assistant",
      usage: {
        costUsd: 0.0456,
        tokens: {
          input: 900,
          output: 120,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    })
  })

  test("extracts nested cache token metadata from OpenCode usage payloads", () => {
    const output = [
      JSON.stringify({
        type: "message.part.updated",
        sessionID: "ses_nested_usage",
        part: {
          id: "prt_finish",
          sessionID: "ses_nested_usage",
          messageID: "msg_usage",
          type: "step-finish",
          cost: 0.0789,
          tokens: {
            input: 700,
            output: 80,
            reasoning: 5,
            cache: {
              read: 123,
              write: 45,
            },
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_nested_usage",
        part: {
          id: "prt_text",
          sessionID: "ses_nested_usage",
          messageID: "msg_usage",
          type: "text",
          text: '{"summary":"ok","verdict":"pass","findings":[],"unmappedNotes":[]}',
        },
      }),
    ].join("\n")

    expect(extractOpenCodeRunResult(output)).toEqual({
      response: '{"summary":"ok","verdict":"pass","findings":[],"unmappedNotes":[]}',
      sessionId: "ses_nested_usage",
      usage: {
        costUsd: 0.0789,
        tokens: {
          input: 700,
          output: 80,
          reasoning: 5,
          cacheRead: 123,
          cacheWrite: 45,
        },
      },
    })
  })

  test("fails on empty output", () => {
    expect(() => extractFinalResponse("")).toThrow("OpenCode did not return a final response.")
  })

  test("surfaces the embedded OpenCode error event message", () => {
    const output = [
      JSON.stringify({
        type: "step_start",
        timestamp: 1774010510111,
        sessionID: "ses_test",
        part: {
          id: "prt_test",
          sessionID: "ses_test",
          messageID: "msg_test",
          type: "step-start",
          snapshot: "snap",
        },
      }),
      JSON.stringify({
        type: "error",
        timestamp: 1774010510115,
        sessionID: "ses_test",
        error: {
          name: "ProviderAuthError",
          data: {
            message: "Missing OpenAI API key.",
          },
        },
      }),
    ].join("\n")

    expect(() => extractFinalResponse(output)).toThrow("ProviderAuthError: Missing OpenAI API key.")
  })

  test("cleans up temp config directories after a run", async () => {
    let configDir = ""

    const result = await Effect.runPromise(
      runOpenCode(
        makeOpenCodeRunRequest({
          workspace: process.cwd(),
          prompt: "prompt",
        }),
        makeProcessRunner((input) => {
          configDir = input.env?.OPENCODE_CONFIG_DIR ?? ""
          expect(input.command).toBe("opencode")

          return Effect.succeed({
            exitCode: 0,
            stdout: JSON.stringify({
              text: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
            }),
            stderr: "",
          })
        }),
      ),
    )

    expect(result.response).toContain('"summary":"Summary"')
    expect(configDir).not.toBe("")
    expect(existsSync(configDir)).toBe(false)
  })

  test("passes the configured timeout to the OpenCode process", async () => {
    let timeout: Duration.Duration | undefined

    await Effect.runPromise(
      runOpenCode(
        makeOpenCodeRunRequest({
          workspace: process.cwd(),
          timeout: Duration.seconds(450),
        }),
        makeProcessRunner((input) => {
          timeout = input.timeout

          return Effect.succeed({
            exitCode: 0,
            stdout: JSON.stringify({
              text: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
            }),
            stderr: "",
          })
        }),
      ),
    )

    expect(timeout === undefined ? undefined : Duration.toMillis(timeout)).toBe(450_000)
  })

  test("passes the configured OpenCode variant to the process", async () => {
    let args: ReadonlyArray<string> = []

    await Effect.runPromise(
      runOpenCode(
        makeOpenCodeRunRequest({
          workspace: process.cwd(),
          variant: "high",
        }),
        makeProcessRunner((input) => {
          args = input.args

          return Effect.succeed({
            exitCode: 0,
            stdout: JSON.stringify({
              text: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
            }),
            stderr: "",
          })
        }),
      ),
    )

    expect(args).toContain("--variant")
    expect(args).toContain("high")
  })

  test("raises the process output cap for large OpenCode event streams", async () => {
    let maxOutputBytes: number | undefined
    const largePrelude = "x".repeat(1_100_000)

    const result = await Effect.runPromise(
      runOpenCode(
        makeOpenCodeRunRequest({
          workspace: process.cwd(),
        }),
        makeProcessRunner((input) => {
          maxOutputBytes = input.maxOutputBytes

          return Effect.succeed({
            exitCode: 0,
            stdout: [
              JSON.stringify({
                text: largePrelude,
              }),
              JSON.stringify({
                text: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
              }),
            ].join("\n"),
            stderr: "",
          })
        }),
      ),
    )

    expect(maxOutputBytes).toBe(10_000_000)
    expect(result.response).toBe('{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}')
  })

  test("keeps the large review prompt out of the command-line arguments", async () => {
    let args: ReadonlyArray<string> = []
    const prompt = "review context ".repeat(20_000)

    await Effect.runPromise(
      runOpenCode(
        makeOpenCodeRunRequest({
          workspace: process.cwd(),
          prompt,
        }),
        makeProcessRunner((input) => {
          args = input.args

          return Effect.succeed({
            exitCode: 0,
            stdout: JSON.stringify({
              text: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
            }),
            stderr: "",
          })
        }),
      ),
    )

    expect(args).not.toContain(prompt)
    expect(args.at(-1)).toBe("Review the pull request using your configured instructions and return strict JSON only.")
  })

  test("fails when OpenCode exits non-zero", async () => {
    const exit = await Effect.runPromiseExit(
      runOpenCode(
        makeOpenCodeRunRequest({
          workspace: process.cwd(),
        }),
        makeProcessRunner(() =>
          Effect.succeed({
            exitCode: 1,
            stdout: "",
            stderr: "boom",
          }),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })
})
