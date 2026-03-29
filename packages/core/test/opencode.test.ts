import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Logger } from "effect"
import * as Duration from "effect/Duration"
import * as TestConsole from "effect/testing/TestConsole"
import type { AssistantMessage, Event, Part, Todo, ToolPart } from "@opencode-ai/sdk/v2"

import { makeRuntimeLogger } from "@open-azdo/core/logging"
import { OpenCodeRunner, buildOpenCodeConfig } from "@open-azdo/core/opencode"

import { makeOpenCodeLiveLayer, makeOpenCodeRunRequest, makeOpenCodeSdkRuntime, withSilentLogs } from "./helpers"
import {
  decodePromptResult,
  initialOpenCodeProgressState,
  isOpenCodeProgressEventForSession,
  reduceOpenCodeProgressBatch,
  runOpenCodeProgressLogger,
  subscribeToOpenCodeEvents,
  withOpenCodeProgressSubscription,
} from "../src/opencode/internal/Layers/OpenCodeSdkRuntime"
import type { OpenCodeSdkPromptRequest } from "../src/opencode/internal/Services/OpenCodeSdkRuntime"

const runOpenCode = (
  request = makeOpenCodeRunRequest(),
  sdkRuntime = makeOpenCodeSdkRuntime(() => Effect.die("sdk runtime not configured")),
) =>
  Effect.gen(function* () {
    const service = yield* OpenCodeRunner
    return yield* service.run(request)
  }).pipe(Effect.provide(makeOpenCodeLiveLayer(sdkRuntime)), withSilentLogs)

type TestOpenCodeEventClient = Parameters<typeof subscribeToOpenCodeEvents>[0]["client"]
type TestSubscribe = TestOpenCodeEventClient["event"]["subscribe"]

const makeEventClient = (subscribe: TestSubscribe): TestOpenCodeEventClient =>
  ({
    event: {
      subscribe,
    },
  }) as TestOpenCodeEventClient

const makeEventStream = (
  events: ReadonlyArray<Event>,
  options?: { readonly failWith?: unknown },
): AsyncIterable<Event> => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) {
      yield event
    }

    if (options?.failWith !== undefined) {
      throw options.failWith
    }
  },
})

const sessionStatusEvent = (
  sessionID: string,
  status: Extract<Event, { readonly type: "session.status" }>["properties"]["status"],
): Event => ({
  type: "session.status",
  properties: {
    sessionID,
    status,
  },
})

const toolEvent = (sessionID: string, callID: string, tool: string, state: ToolPart["state"]): Event => ({
  type: "message.part.updated",
  properties: {
    sessionID,
    time: Date.now(),
    part: {
      id: `${callID}-part`,
      sessionID,
      messageID: `${callID}-message`,
      type: "tool",
      callID,
      tool,
      state,
    } satisfies ToolPart,
  },
})

const todoEvent = (sessionID: string, todos: ReadonlyArray<Todo>): Event => ({
  type: "todo.updated",
  properties: {
    sessionID,
    todos: [...todos],
  },
})

const sessionErrorEvent = (
  sessionID: string,
  error: Extract<Event, { readonly type: "session.error" }>["properties"]["error"],
): Event => ({
  type: "session.error",
  properties: {
    sessionID,
    ...(error !== undefined ? { error } : {}),
  },
})

const collectProgressLogs = async (events: AsyncIterable<Event>, sessionId = "ses_target") => {
  const errorLines = await Effect.runPromise(
    Effect.gen(function* () {
      yield* runOpenCodeProgressLogger({
        events,
        sessionId,
      })

      return yield* TestConsole.errorLines
    }).pipe(Effect.provide(Logger.layer([makeRuntimeLogger(true)])), Effect.provide(TestConsole.layer)),
  )

  return errorLines.map(
    (line) => JSON.parse(String(line)) as { readonly message: string; readonly annotations?: Record<string, unknown> },
  )
}

const collectEffectConsole = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const value = yield* effect

    return {
      value,
      errorLines: yield* TestConsole.errorLines,
      logLines: yield* TestConsole.logLines,
    }
  }).pipe(
    Effect.provide(Logger.layer([makeRuntimeLogger(true)])),
    Effect.provide(Layer.succeed(Logger.LogToStderr)(true)),
    Effect.provide(TestConsole.layer),
  )

const reduceProgressLogs = (events: ReadonlyArray<Event>, sessionId = "ses_target") =>
  reduceOpenCodeProgressBatch(
    initialOpenCodeProgressState,
    events.filter((event) => isOpenCodeProgressEventForSession(event, sessionId)),
  ).logs

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

  test("passes through native openai gpt-5.4-mini models without provider overrides", async () => {
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
      providerID: "openai",
      modelID: "gpt-5.4-mini",
    })
    expect(receivedRequest?.config).toEqual(buildOpenCodeConfig(request.agent))
  })

  test("allows lsp queries in the generated opencode config", () => {
    expect(buildOpenCodeConfig("azdo-review")).toEqual(
      expect.objectContaining({
        lsp: expect.objectContaining({
          typescript: expect.objectContaining({
            command: [process.execPath, "x", "typescript-language-server", "--stdio"],
          }),
        }),
        permission: expect.objectContaining({
          lsp: "allow",
        }),
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

  test("passes Effect cancellation into event.subscribe", async () => {
    let capturedSignal: AbortSignal | undefined

    const subscription = await Effect.runPromise(
      subscribeToOpenCodeEvents({
        client: makeEventClient(((_, options) => {
          capturedSignal = options?.signal ?? undefined
          return Promise.resolve({
            stream: makeEventStream([]),
          })
        }) as TestSubscribe),
      }),
    )

    expect(subscription.stream).toBeDefined()
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal?.aborted).toBe(false)
  })

  test("aborts the sdk subscription when acquisition is interrupted", async () => {
    let capturedSignal: AbortSignal | undefined
    let sawAbort = false

    const fiber = Effect.runFork(
      subscribeToOpenCodeEvents({
        client: makeEventClient(
          ((_, options) =>
            new Promise(() => {
              capturedSignal = options?.signal ?? undefined
              options?.signal?.addEventListener(
                "abort",
                () => {
                  sawAbort = true
                },
                { once: true },
              )
            })) as TestSubscribe,
        ),
      }),
    )

    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(capturedSignal).toBeDefined()
    expect(capturedSignal?.aborted).toBe(true)
    expect(sawAbort).toBe(true)
  })

  test("cleans up the progress subscription without logging abort warnings", async () => {
    let capturedSignal: AbortSignal | undefined
    let streamClosed = false
    let resolveStreamStarted!: () => void
    const streamStarted = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve
    })

    const output = await Effect.runPromise(
      collectEffectConsole(
        withOpenCodeProgressSubscription(
          {
            client: makeEventClient(((_, options) => {
              capturedSignal = options?.signal ?? undefined

              return Promise.resolve({
                stream: {
                  async *[Symbol.asyncIterator]() {
                    yield* []

                    try {
                      resolveStreamStarted()

                      await new Promise((_, reject) => {
                        options?.signal?.addEventListener(
                          "abort",
                          () => {
                            const error = new Error("stream aborted")
                            error.name = "AbortError"
                            reject(error)
                          },
                          { once: true },
                        )
                      })
                    } finally {
                      streamClosed = true
                    }
                  },
                },
              })
            }) as TestSubscribe),
            sessionId: "ses_target",
          },
          Effect.tryPromise(() => streamStarted).pipe(Effect.as("done")),
        ),
      ),
    )

    // Allow the abort-driven stream shutdown to settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(output.value).toBe("done")
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal?.aborted).toBe(true)
    expect(streamClosed).toBe(true)
    expect(
      output.errorLines.some((line) =>
        String(line).includes("OpenCode event stream failed. Continuing without live progress updates."),
      ),
    ).toBe(false)
  })

  test("filters progress events to the active session", () => {
    const logs = reduceProgressLogs([
      sessionStatusEvent("ses_other", { type: "busy" }),
      sessionStatusEvent("ses_target", { type: "busy" }),
      toolEvent("ses_other", "call_other", "bash", {
        status: "running",
        input: {
          command: "echo ignored",
        },
        time: {
          start: 1,
        },
      }),
    ])

    expect(logs).toHaveLength(1)
    expect(logs[0]?.message).toBe("OpenCode assistant is working.")
  })

  test("dedupes repeated busy events and retry attempts", () => {
    const logs = reduceProgressLogs([
      sessionStatusEvent("ses_target", { type: "busy" }),
      sessionStatusEvent("ses_target", { type: "busy" }),
      sessionStatusEvent("ses_target", {
        type: "retry",
        attempt: 1,
        message: "model asked for another attempt",
        next: 500,
      }),
      sessionStatusEvent("ses_target", {
        type: "retry",
        attempt: 1,
        message: "model asked for another attempt",
        next: 500,
      }),
    ])

    expect(logs.map((entry) => entry.message)).toEqual([
      "OpenCode assistant is working.",
      "OpenCode is retrying the assistant response.",
    ])
    expect(logs[1]?.fields?.attempt).toBe(1)
  })

  test("summarizes tool and todo progress without raw tool output", () => {
    const logs = reduceProgressLogs([
      toolEvent("ses_target", "call_bash", "bash", {
        status: "running",
        input: {
          command: "echo hello",
        },
        title: "Run command",
        time: {
          start: 1,
        },
      }),
      toolEvent("ses_target", "call_bash", "bash", {
        status: "completed",
        input: {
          command: "echo hello",
        },
        output: "full raw output that should never be logged",
        title: "Run command",
        metadata: {},
        time: {
          start: 1,
          end: 6,
        },
      }),
      toolEvent("ses_target", "call_edit", "edit", {
        status: "error",
        input: {
          filePath: "src/example.ts",
        },
        error: "write failed",
        time: {
          start: 10,
          end: 18,
        },
      }),
      todoEvent("ses_target", [
        {
          content: "Inspect diff",
          status: "completed",
          priority: "high",
        },
        {
          content: "Write summary",
          status: "in_progress",
          priority: "medium",
        },
      ]),
    ])

    expect(logs.map((entry) => entry.message)).toEqual([
      "🔧 echo hello",
      "⚠️ edit: src/example.ts",
      "OpenCode updated its task plan.",
    ])
    expect(JSON.stringify(logs)).not.toContain("full raw output that should never be logged")
    expect(logs[2]?.fields?.counts).toEqual({
      completed: 1,
      in_progress: 1,
    })
  })

  test("renders glob progress from the tool pattern input", () => {
    const logs = reduceProgressLogs([
      toolEvent("ses_target", "call_glob", "glob", {
        status: "running",
        input: {
          path: "/workspace",
          pattern: "**/*.yaml",
        },
        time: {
          start: 1,
        },
      }),
    ])

    expect(logs.map((entry) => entry.message)).toEqual(["✱ **/*.yaml"])
  })

  test("summarizes session errors", () => {
    const logs = reduceProgressLogs([
      sessionErrorEvent("ses_target", {
        name: "APIError",
        data: {
          message: "boom",
          isRetryable: false,
        },
      }),
    ])

    expect(logs).toEqual([
      {
        level: "warning",
        message: "OpenCode reported a session error.",
        fields: {
          name: "APIError",
          errorMessage: "boom",
        },
      },
    ])
  })

  test("downgrades event stream failures to a warning", async () => {
    const logs = await collectProgressLogs(
      makeEventStream([], {
        failWith: new Error("stream broke"),
      }),
    )

    expect(logs.map((entry) => entry.message)).toEqual([
      "OpenCode event stream failed. Continuing without live progress updates.",
    ])
    expect(logs[0]?.annotations?.detail).toEqual(expect.stringContaining("stream broke"))
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
