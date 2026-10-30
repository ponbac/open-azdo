import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Logger } from "effect"
import * as Duration from "effect/Duration"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import type { EventSubscribeOutput as Event, SessionMessageAssistant, SessionMessageIdle } from "@opencode/client"

import { OpenCodeInvocationError, OpenCodeOutputError } from "@open-azdo/core/errors"
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
import {
  OPEN_CODE_STRUCTURED_OUTPUT_TOOL,
  type OpenCodeSdkPromptRequest,
} from "../src/opencode/internal/Services/OpenCodeSdkRuntime"

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

const connectedEvent = { id: "evt-connected", type: "server.connected", data: {} } as Event

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

const sessionEvent = (type: Event["type"], data: Record<string, unknown>, created = 1_000): Event =>
  ({
    id: `evt-${type}`,
    created,
    type,
    data,
  }) as Event

const executionStarted = (sessionID: string) => sessionEvent("session.execution.started", { sessionID })

const toolStarted = (sessionID: string, id: string, name: string) =>
  sessionEvent("session.tool.input.started", { sessionID, assistantMessageID: "msg", id, name })

const toolCalled = (sessionID: string, id: string, input: Record<string, unknown>) =>
  sessionEvent("session.tool.called", { sessionID, assistantMessageID: "msg", id, input, executed: true })

const toolFailed = (sessionID: string, id: string, message: string) =>
  sessionEvent("session.tool.failed", {
    sessionID,
    assistantMessageID: "msg",
    id,
    error: { type: "tool.execution", message },
    executed: true,
  })

const retryScheduled = (sessionID: string, attempt: number) =>
  sessionEvent("session.retry.scheduled", {
    sessionID,
    assistantMessageID: "msg",
    attempt,
    at: 1_500,
    error: { type: "provider.rate-limit", message: "Rate limited" },
  })

const executionFailed = (sessionID: string, type: string, message: string) =>
  sessionEvent("session.execution.failed", { sessionID, error: { type, message } })

const assistantMessage = (overrides: Partial<SessionMessageAssistant>): SessionMessageAssistant => ({
  id: "msg_123",
  time: { created: 1, completed: 2 },
  type: "assistant",
  agent: "azdo-review",
  model: { id: "gpt-5.4", providerID: "openai" },
  content: [],
  ...overrides,
})

const idleMessage = (overrides: Partial<SessionMessageIdle> = {}): SessionMessageIdle => ({
  id: "msg_idle",
  time: { created: 3 },
  type: "idle",
  outcome: "succeeded",
  ...overrides,
})

const usage = {
  costUsd: 0.12,
  tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 10, cacheWrite: 2 },
}

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

  test("denies by default and only allows read-only tools for the review agent", () => {
    const config = buildOpenCodeConfig("azdo-review")
    const permissions = config.agents["azdo-review"]?.permissions ?? []

    // V2 asks on unmatched requests, which would hang a headless run, and the last match wins.
    expect(permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    expect(permissions.slice(1).every((rule) => rule.effect === "allow")).toBe(true)
    expect(new Set(permissions.slice(1).map((rule) => rule.action))).toEqual(
      new Set(["read", "glob", "grep", "shell", OPEN_CODE_STRUCTURED_OUTPUT_TOOL]),
    )
    expect(permissions.filter((rule) => rule.action === "shell").map((rule) => rule.resource)).not.toContain("*")
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
              name: "provider.invalid-request",
              message: "schema mismatch",
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
        name: "provider.invalid-request",
        message: "schema mismatch",
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
    const response = '{"verdict":"concerns","findings":[],"unmappedNotes":[]}'
    const result = await Effect.runPromise(
      decodePromptResult({
        sessionId: "ses_123",
        latest: assistantMessage({
          content: [{ type: "text", text: response }],
          error: { type: "provider.output-length", message: "Output limit reached" },
        }),
        structured: undefined,
        idle: idleMessage({ outcome: "failed" }),
        usage,
      }),
    )

    expect(result).toEqual({
      response,
      sessionId: "ses_123",
      usage,
      modelError: {
        name: "provider.output-length",
        message: "Output limit reached",
      },
    })
  })

  test("keeps a submitted result when a later model call fails", async () => {
    const structured = { verdict: "pass", findings: [], unmappedNotes: [] }
    const error = { type: "provider.invalid-request", message: "Context too long" }
    const result = await Effect.runPromise(
      decodePromptResult({
        sessionId: "ses_456",
        latest: assistantMessage({ error }),
        structured,
        idle: idleMessage({ outcome: "failed", error }),
        usage,
      }),
    )

    expect(result).toEqual({
      response: "",
      structured,
      sessionId: "ses_456",
      usage,
      modelError: { name: error.type, message: error.message },
    })
  })

  test("fails turns that end without a usable payload", async () => {
    const error = {
      type: "provider.auth",
      message: "Provider request failed.",
      response: { body: "echoed-request-secret" },
    }
    const failure = await Effect.runPromise(
      decodePromptResult({
        sessionId: "ses_789",
        latest: undefined,
        structured: undefined,
        idle: idleMessage({ outcome: "failed", error }),
        usage,
      }).pipe(Effect.flip),
    )

    expect(failure).toBeInstanceOf(OpenCodeOutputError)
    expect(JSON.stringify(failure)).toContain("Provider request failed.")
    expect(JSON.stringify(failure)).not.toContain("echoed-request-secret")
  })

  test("fails interrupted turns that end without a usable payload", async () => {
    const failure = await Effect.runPromise(
      decodePromptResult({
        sessionId: "ses_789",
        latest: undefined,
        structured: undefined,
        idle: idleMessage({ outcome: "interrupted" }),
        usage,
      }).pipe(Effect.flip),
    )

    expect(failure).toBeInstanceOf(OpenCodeInvocationError)
  })

  test("aborts the event subscription when acquisition is interrupted", async () => {
    let capturedSignal: AbortSignal | undefined

    const fiber = Effect.runFork(
      subscribeToOpenCodeEvents({
        client: makeEventClient(((options) => {
          capturedSignal = options?.signal
          return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
        }) as TestSubscribe),
        lifetime: new AbortController().signal,
      }),
    )

    await Effect.runPromise(Effect.yieldNow.pipe(Effect.andThen(Fiber.interrupt(fiber))))

    expect(capturedSignal?.aborted).toBe(true)
  })

  test("continues without progress when the event stream never connects", async () => {
    let capturedSignal: AbortSignal | undefined

    const program = Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>()
      const fiber = yield* withOpenCodeProgressSubscription(
        {
          client: makeEventClient(((options) => {
            capturedSignal = options?.signal
            Deferred.doneUnsafe(subscribed, Exit.void)
            return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
          }) as TestSubscribe),
          sessionId: "ses_target",
        },
        Effect.succeed("prompted"),
      ).pipe(Effect.forkChild)

      yield* Deferred.await(subscribed)
      yield* Effect.yieldNow
      yield* TestClock.adjust("5 seconds")

      return yield* Fiber.join(fiber)
    })

    const output = await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), withSilentLogs))

    expect(output).toBe("prompted")
    expect(capturedSignal?.aborted).toBe(true)
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
            client: makeEventClient(((options) => {
              capturedSignal = options?.signal

              return {
                async *[Symbol.asyncIterator]() {
                  yield connectedEvent

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
              }
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
      executionStarted("ses_other"),
      executionStarted("ses_target"),
      toolStarted("ses_other", "call_other", "shell"),
      toolCalled("ses_other", "call_other", { command: "echo ignored" }),
    ])

    expect(logs.map((log) => log.message)).toEqual(["OpenCode assistant is working."])
  })

  test("dedupes repeated retry attempts", () => {
    const logs = reduceProgressLogs([
      retryScheduled("ses_target", 1),
      retryScheduled("ses_target", 1),
      retryScheduled("ses_target", 2),
    ])

    expect(logs).toEqual([
      {
        level: "info",
        message: "OpenCode is retrying the assistant response.",
        fields: { attempt: 1, nextDelayMs: 500, retryMessage: "Rate limited" },
      },
      {
        level: "info",
        message: "OpenCode is retrying the assistant response.",
        fields: { attempt: 2, nextDelayMs: 500, retryMessage: "Rate limited" },
      },
    ])
  })

  test("summarizes tool progress without raw tool output", () => {
    const logs = reduceProgressLogs([
      toolStarted("ses_target", "call_1", "shell"),
      toolCalled("ses_target", "call_1", { command: "git diff HEAD~1 HEAD" }),
      toolStarted("ses_target", "call_2", "glob"),
      toolCalled("ses_target", "call_2", { pattern: "src/**/*.ts" }),
      toolFailed("ses_target", "call_2", "x".repeat(300)),
    ])

    expect(logs.map((log) => log.message)).toEqual(["🔧 git diff HEAD~1 HEAD", "✱ src/**/*.ts", "⚠️ glob: src/**/*.ts"])
    expect(logs[2]?.level).toBe("warning")
    expect(String(logs[2]?.fields?.error).length).toBeLessThan(300)
  })

  test("summarizes session errors", () => {
    const logs = reduceProgressLogs([executionFailed("ses_target", "provider.auth", "Invalid API key")])

    expect(logs).toEqual([
      {
        level: "warning",
        message: "OpenCode reported a session error.",
        fields: { name: "provider.auth", errorMessage: "Invalid API key" },
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
