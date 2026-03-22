import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Duration from "effect/Duration"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"

import { OpenCodeRunner, buildOpenCodeConfig } from "@open-azdo/core/opencode"

import { makeOpenCodeLiveLayer, makeOpenCodeRunRequest, makeOpenCodeSdkRuntime, withSilentLogs } from "./helpers"
import { decodePromptResult } from "../src/opencode/internal/Layers/OpenCodeSdkRuntime"
import type { OpenCodeSdkPromptRequest } from "../src/opencode/internal/Services/OpenCodeSdkRuntime"

const runOpenCode = (
  request = makeOpenCodeRunRequest(),
  sdkRuntime = makeOpenCodeSdkRuntime(() => Effect.die("sdk runtime not configured")),
) =>
  Effect.gen(function* () {
    const service = yield* OpenCodeRunner
    return yield* service.run(request)
  }).pipe(Effect.provide(makeOpenCodeLiveLayer(sdkRuntime)), withSilentLogs)

describe("opencode", () => {
  test("passes parsed model, prompt, config, format, and variant to the sdk runtime", async () => {
    let receivedRequest: OpenCodeSdkPromptRequest | undefined
    const sdkRuntime = makeOpenCodeSdkRuntime((request) => {
      receivedRequest = request

      return Effect.succeed({
        response: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
      })
    })

    const request = makeOpenCodeRunRequest({
      workspace: process.cwd(),
      model: "azure/deployments/gpt-5.4-mini",
      variant: "high",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
        },
        retryCount: 2,
      },
    })

    const result = await Effect.runPromise(runOpenCode(request, sdkRuntime))

    expect(result.response).toContain('"summary":"Summary"')
    expect(receivedRequest).toEqual({
      workspace: process.cwd(),
      model: {
        providerID: "azure",
        modelID: "deployments/gpt-5.4-mini",
      },
      agent: request.agent,
      variant: "high",
      timeout: request.timeout,
      prompt: request.prompt,
      inheritedEnv: {},
      format: request.format,
      config: buildOpenCodeConfig(request.agent),
    })
  })

  test("adds an OpenAI direct provider fallback for unsupported gpt-5 mini-family ids", async () => {
    let receivedRequest: OpenCodeSdkPromptRequest | undefined
    const sdkRuntime = makeOpenCodeSdkRuntime((request) => {
      receivedRequest = request

      return Effect.succeed({
        response: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
      })
    })

    const request = makeOpenCodeRunRequest({
      workspace: process.cwd(),
      model: "openai/gpt-5.4-mini",
    })

    await Effect.runPromise(runOpenCode(request, sdkRuntime))

    expect(receivedRequest?.model).toEqual({
      providerID: "openai-direct",
      modelID: "gpt-5.4-mini",
    })
    expect(receivedRequest?.config).toEqual(
      buildOpenCodeConfig(request.agent, {
        providerID: "openai",
        modelID: "gpt-5.4-mini",
      }),
    )
  })

  test("returns structured output and model error metadata from the sdk runtime", async () => {
    const result = await Effect.runPromise(
      runOpenCode(
        makeOpenCodeRunRequest(),
        makeOpenCodeSdkRuntime(() =>
          Effect.succeed({
            response: '{"summary":"Summary"}',
            structured: {
              summary: "Summary",
              verdict: "pass",
              findings: [],
              unmappedNotes: [],
            },
            sessionId: "ses_123",
            usage: {
              costUsd: 0.12,
              tokens: {
                input: 100,
                output: 20,
                reasoning: 5,
                cacheRead: 10,
                cacheWrite: 2,
              },
            },
            modelError: {
              name: "StructuredOutputError",
              message: "schema mismatch",
              retries: 2,
            },
          }),
        ),
      ),
    )

    expect(result).toEqual({
      response: '{"summary":"Summary"}',
      structured: {
        summary: "Summary",
        verdict: "pass",
        findings: [],
        unmappedNotes: [],
      },
      sessionId: "ses_123",
      usage: {
        costUsd: 0.12,
        tokens: {
          input: 100,
          output: 20,
          reasoning: 5,
          cacheRead: 10,
          cacheWrite: 2,
        },
      },
      modelError: {
        name: "StructuredOutputError",
        message: "schema mismatch",
        retries: 2,
      },
    })
  })

  test("fails when the model has no provider separator", async () => {
    const exit = await Effect.runPromiseExit(
      runOpenCode(
        makeOpenCodeRunRequest({
          model: "gpt-5.4",
        }),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("fails when the model provider segment is empty", async () => {
    const exit = await Effect.runPromiseExit(
      runOpenCode(
        makeOpenCodeRunRequest({
          model: "/gpt-5.4",
        }),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("fails when the model id segment is empty", async () => {
    const exit = await Effect.runPromiseExit(
      runOpenCode(
        makeOpenCodeRunRequest({
          model: "openai/",
        }),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("salvages partial text for assistant output errors", async () => {
    const result = await Effect.runPromise(
      decodePromptResult({
        info: {
          id: "msg_123",
          sessionID: "ses_123",
          role: "assistant",
          time: {
            created: 1,
            completed: 2,
          },
          parentID: "msg_parent",
          modelID: "gpt-5.4",
          providerID: "openai",
          mode: "primary",
          agent: "azdo-review",
          path: {
            cwd: "/tmp/workspace",
            root: "/tmp/workspace",
          },
          cost: 0.12,
          tokens: {
            input: 100,
            output: 20,
            reasoning: 5,
            cache: {
              read: 10,
              write: 2,
            },
          },
          error: {
            name: "MessageOutputLengthError",
            data: {},
          },
        } satisfies AssistantMessage,
        parts: [
          {
            id: "prt_123",
            sessionID: "ses_123",
            messageID: "msg_123",
            type: "text",
            text: '{"summary":"Partial summary","verdict":"concerns","findings":[],"unmappedNotes":[]}',
          },
        ] satisfies Part[],
      }),
    )

    expect(result).toEqual({
      response: '{"summary":"Partial summary","verdict":"concerns","findings":[],"unmappedNotes":[]}',
      sessionId: "ses_123",
      usage: {
        costUsd: 0.12,
        tokens: {
          input: 100,
          output: 20,
          reasoning: 5,
          cacheRead: 10,
          cacheWrite: 2,
        },
      },
      modelError: {
        name: "MessageOutputLengthError",
        message: "MessageOutputLengthError",
      },
    })
  })

  test("salvages structured payloads for assistant errors without text", async () => {
    const result = await Effect.runPromise(
      decodePromptResult({
        info: {
          id: "msg_456",
          sessionID: "ses_456",
          role: "assistant",
          time: {
            created: 1,
            completed: 2,
          },
          parentID: "msg_parent",
          modelID: "gpt-5.4",
          providerID: "openai",
          mode: "primary",
          agent: "azdo-review",
          path: {
            cwd: "/tmp/workspace",
            root: "/tmp/workspace",
          },
          cost: 0.34,
          tokens: {
            input: 150,
            output: 0,
            reasoning: 0,
            cache: {
              read: 0,
              write: 0,
            },
          },
          structured: {
            summary: "Structured fallback",
            verdict: "concerns",
            findings: [],
            unmappedNotes: [],
          },
          error: {
            name: "ContextOverflowError",
            data: {
              message: "Context window exceeded.",
            },
          },
        } satisfies AssistantMessage,
        parts: [],
      }),
    )

    expect(result).toEqual({
      response: "",
      structured: {
        summary: "Structured fallback",
        verdict: "concerns",
        findings: [],
        unmappedNotes: [],
      },
      sessionId: "ses_456",
      usage: {
        costUsd: 0.34,
        tokens: {
          input: 150,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      modelError: {
        name: "ContextOverflowError",
        message: "Context window exceeded.",
      },
    })
  })

  test("handles prompt responses that omit parts when structured output is present", async () => {
    const result = await Effect.runPromise(
      decodePromptResult({
        info: {
          id: "msg_missing_parts",
          sessionID: "ses_missing_parts",
          role: "assistant",
          time: {
            created: 1,
            completed: 2,
          },
          parentID: "msg_parent",
          modelID: "gpt-5.4-nano",
          providerID: "openai",
          mode: "primary",
          agent: "azdo-review",
          path: {
            cwd: "/tmp/workspace",
            root: "/tmp/workspace",
          },
          cost: 0.01,
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cache: {
              read: 0,
              write: 0,
            },
          },
          structured: {
            summary: "Structured only",
            verdict: "pass",
            findings: [],
            unmappedNotes: [],
          },
        } satisfies AssistantMessage,
        parts: undefined,
      }),
    )

    expect(result).toEqual({
      response: "",
      structured: {
        summary: "Structured only",
        verdict: "pass",
        findings: [],
        unmappedNotes: [],
      },
      sessionId: "ses_missing_parts",
      usage: {
        costUsd: 0.01,
        tokens: {
          input: 10,
          output: 5,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    })
  })

  test("fails assistant errors that return no usable payload", async () => {
    const exit = await Effect.runPromiseExit(
      decodePromptResult({
        info: {
          id: "msg_789",
          sessionID: "ses_789",
          role: "assistant",
          time: {
            created: 1,
            completed: 2,
          },
          parentID: "msg_parent",
          modelID: "gpt-5.4",
          providerID: "openai",
          mode: "primary",
          agent: "azdo-review",
          path: {
            cwd: "/tmp/workspace",
            root: "/tmp/workspace",
          },
          cost: 0,
          tokens: {
            input: 100,
            output: 0,
            reasoning: 0,
            cache: {
              read: 0,
              write: 0,
            },
          },
          error: {
            name: "APIError",
            data: {
              message: "Provider request failed.",
              isRetryable: false,
            },
          },
        } satisfies AssistantMessage,
        parts: [],
      }),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("passes the configured timeout through to the sdk runtime", async () => {
    let timeout: Duration.Duration | undefined

    await Effect.runPromise(
      runOpenCode(
        makeOpenCodeRunRequest({
          timeout: Duration.seconds(450),
        }),
        makeOpenCodeSdkRuntime((request) => {
          timeout = request.timeout

          return Effect.succeed({
            response: '{"summary":"Summary","verdict":"pass","findings":[],"unmappedNotes":[]}',
          })
        }),
      ),
    )

    expect(timeout === undefined ? undefined : Duration.toMillis(timeout)).toBe(450_000)
  })
})
