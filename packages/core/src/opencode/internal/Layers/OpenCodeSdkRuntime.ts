import { createServer } from "node:net"

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { AssistantMessage, Event, Part, SessionStatus, Todo, ToolPart } from "@opencode-ai/sdk/v2"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"

import { Duration, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"

import { OpenCodeInvocationError, OpenCodeOutputError } from "../../../errors"
import { formatUnknownDetail } from "../../../format-unknown"
import { stringifyJson } from "../../../Json"
import { logInfo, logWarning, truncateForLog } from "../../../Logging"
import { type OpenCodeModelError, type OpenCodeRunTokens, type OpenCodeRunUsage } from "../../Services/OpenCodeRunner"
import {
  OpenCodeSdkRuntime,
  type OpenCodeSdkPromptRequest,
  type OpenCodeSdkPromptResult,
} from "../Services/OpenCodeSdkRuntime"

const SERVER_HOST = "127.0.0.1"

const toInvocationError = ({
  message,
  detail,
  exitCode = -1,
}: {
  readonly message: string
  readonly detail?: string | undefined
  readonly exitCode?: number | undefined
}) =>
  new OpenCodeInvocationError({
    message,
    stderr: detail ?? "",
    exitCode,
  })

const toOutputError = (message: string, output = "") =>
  new OpenCodeOutputError({
    message,
    output,
  })

const awaitWithin = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeout: Duration.Duration,
  onTimeout: () => OpenCodeInvocationError,
) =>
  effect.pipe(
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () => Effect.fail(onTimeout()),
        onSome: Effect.succeed,
      }),
    ),
  )

const ignoreFailure = <E>(effect: Effect.Effect<unknown, E>) =>
  effect.pipe(
    Effect.match({
      onFailure: () => undefined,
      onSuccess: () => undefined,
    }),
  )

type OpenCodeEvent = Event
type OpenCodeClient = ReturnType<typeof createOpencodeClient>
type OpenCodeEventClient = Pick<OpenCodeClient, "event">
type OpenCodeEventSubscribeInput = Parameters<OpenCodeEventClient["event"]["subscribe"]>[0]
type OpenCodeEventSubscribeOptions = Parameters<OpenCodeEventClient["event"]["subscribe"]>[1]

type OpenCodeProgressLog = {
  readonly level: "info" | "warning"
  readonly message: string
  readonly fields?: Record<string, unknown> | undefined
}

type OpenCodeToolProgressState = {
  readonly status: ToolPart["state"]["status"]
}

export type OpenCodeProgressState = {
  readonly lastStatusKey?: string | undefined
  readonly toolStatesByCallId: Readonly<Record<string, OpenCodeToolProgressState>>
  readonly seenRetryAttempts: ReadonlyArray<number>
  readonly todoFingerprint?: string | undefined
  readonly eventStreamFailed: boolean
}

export const initialOpenCodeProgressState: OpenCodeProgressState = {
  toolStatesByCallId: {},
  seenRetryAttempts: [],
  eventStreamFailed: false,
}

const isAbortError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "AbortError" ||
    error.message.includes("abort") ||
    error.message.includes("aborted") ||
    error.message.includes("The operation was aborted"))

const emitProgressLog = (entry: OpenCodeProgressLog) =>
  entry.level === "warning" ? logWarning(entry.message, entry.fields) : logInfo(entry.message, entry.fields)

const mergeAbortSignals = (signal: AbortSignal | null | undefined, lifetime: AbortSignal) =>
  signal === undefined || signal === null ? lifetime : AbortSignal.any([signal, lifetime])

/**
 * Adapts the SDK event client so scoped cleanup can stop an active SSE stream
 * using the lifetime signal, while initial subscription cancellation still
 * comes from Effect.tryPromise.
 */
const withSubscriptionLifetime = (client: OpenCodeEventClient, lifetime: AbortSignal): OpenCodeEventClient => ({
  event: Object.assign(Object.create(client.event), {
    subscribe: (input: OpenCodeEventSubscribeInput, options?: OpenCodeEventSubscribeOptions) =>
      client.event.subscribe(input, {
        ...options,
        signal: mergeAbortSignals(options?.signal, lifetime),
      }),
  }) as OpenCodeEventClient["event"],
})

const sessionStatusKey = (status: SessionStatus) =>
  status.type === "retry" ? `${status.type}:${status.attempt}` : status.type

const TOOL_TITLE_INPUT_KEYS = ["title", "filePath", "command", "query", "pattern", "path", "url"] as const
const TOOL_PROGRESS_ICONS: Record<string, string> = {
  bash: "🔧",
  read: "📖",
  glob: "✱",
  edit: "✏️",
  grep: "🔎",
  list: "📂",
  webfetch: "🌐",
}

const titleFromToolInput = (input: Record<string, unknown>) => {
  for (const key of TOOL_TITLE_INPUT_KEYS) {
    const candidate = input[key]

    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }

  return undefined
}

const getToolTitle = (part: ToolPart) => {
  switch (part.state.status) {
    case "running":
    case "completed":
      return titleFromToolInput(part.state.input) || part.state.title
    case "pending":
    case "error":
      return titleFromToolInput(part.state.input)
  }
}

const getToolDurationMs = (part: ToolPart) => {
  switch (part.state.status) {
    case "completed":
    case "error":
      return Math.max(0, part.state.time.end - part.state.time.start)
    case "pending":
    case "running":
      return undefined
  }
}

const getToolProgressFields = (part: ToolPart) => {
  const title = getToolTitle(part)
  const durationMs = getToolDurationMs(part)

  return {
    tool: part.tool,
    callId: part.callID,
    ...(title ? { title } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}

const getToolProgressIcon = (toolName: string) => TOOL_PROGRESS_ICONS[toolName] ?? "⚙️"

const getToolProgressMessage = (
  phase: "started" | "failed",
  part: ToolPart,
  fields: ReturnType<typeof getToolProgressFields>,
) => {
  const title = fields.title ? truncateForLog(String(fields.title), 160) : undefined
  const icon = getToolProgressIcon(part.tool)

  switch (phase) {
    case "started":
      return title ? `${icon} ${title}` : `${icon} ${part.tool}`
    case "failed":
      return title ? `⚠️ ${part.tool}: ${title}` : `⚠️ ${part.tool}`
  }
}

const getAssistantRunMessage = (request: OpenCodeSdkPromptRequest) =>
  request.variant
    ? `Starting OpenCode assistant run with ${request.model.modelID} (${request.variant}).`
    : "Starting OpenCode assistant run."

const summarizeTodoCounts = (todos: ReadonlyArray<Todo>) => {
  const counts: Record<string, number> = {}

  for (const todo of todos) {
    counts[todo.status] = (counts[todo.status] ?? 0) + 1
  }

  return counts
}

const todoFingerprint = (counts: Record<string, number>) =>
  Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join("|")

const getEventSessionId = (event: OpenCodeEvent): string | undefined => {
  switch (event.type) {
    case "message.part.delta":
    case "message.part.updated":
    case "session.idle":
    case "session.status":
    case "todo.updated":
      return event.properties.sessionID
    case "message.updated":
      return event.properties.info.sessionID
    case "session.error":
      return event.properties.sessionID
    default:
      return undefined
  }
}

export const isOpenCodeProgressEventForSession = (event: OpenCodeEvent, sessionId: string) =>
  getEventSessionId(event) === sessionId

/**
 * Collapses noisy OpenCode SDK events into a small per-session progress model
 * and a concise log stream that is readable in terminals and CI logs.
 */
export const reduceOpenCodeProgressBatch = (
  state: OpenCodeProgressState,
  events: ReadonlyArray<OpenCodeEvent>,
): {
  readonly state: OpenCodeProgressState
  readonly logs: ReadonlyArray<OpenCodeProgressLog>
} => {
  const logs: OpenCodeProgressLog[] = []
  const seenRetryAttempts = new Set(state.seenRetryAttempts)
  const toolStatesByCallId: Record<string, OpenCodeToolProgressState> = {
    ...state.toolStatesByCallId,
  }
  let lastStatusKey = state.lastStatusKey
  let nextTodoFingerprint = state.todoFingerprint

  for (const event of events) {
    switch (event.type) {
      case "session.status": {
        const statusKey = sessionStatusKey(event.properties.status)

        if (event.properties.status.type === "retry") {
          if (!seenRetryAttempts.has(event.properties.status.attempt)) {
            seenRetryAttempts.add(event.properties.status.attempt)
            logs.push({
              level: "info",
              message: "OpenCode is retrying the assistant response.",
              fields: {
                attempt: event.properties.status.attempt,
                nextDelayMs: event.properties.status.next,
                retryMessage: truncateForLog(event.properties.status.message, 160),
              },
            })
          }
        } else if (statusKey !== lastStatusKey) {
          logs.push({
            level: "info",
            message:
              event.properties.status.type === "busy"
                ? "OpenCode assistant is working."
                : "OpenCode assistant is idle.",
          })
        }

        lastStatusKey = statusKey
        break
      }

      case "message.part.updated": {
        if (event.properties.part.type !== "tool") {
          break
        }

        const part = event.properties.part
        const previous = toolStatesByCallId[part.callID]
        const baseFields = getToolProgressFields(part)

        switch (part.state.status) {
          case "running":
            if (previous?.status !== "running") {
              logs.push({
                level: "info",
                message: getToolProgressMessage("started", part, baseFields),
              })
            }
            break
          case "completed":
            break
          case "error":
            if (previous?.status !== "error") {
              logs.push({
                level: "warning",
                message: getToolProgressMessage("failed", part, baseFields),
                fields: {
                  ...baseFields,
                  error: truncateForLog(part.state.error, 200),
                },
              })
            }
            break
          case "pending":
            break
        }

        toolStatesByCallId[part.callID] = {
          status: part.state.status,
        }
        break
      }

      case "todo.updated": {
        // Fingerprint counts instead of todo bodies so repeated updates do not
        // spam logs with the same workplan details.
        const counts = summarizeTodoCounts(event.properties.todos)
        const fingerprint = todoFingerprint(counts)

        if (fingerprint !== nextTodoFingerprint) {
          logs.push({
            level: "info",
            message: "OpenCode updated its task plan.",
            fields: {
              total: event.properties.todos.length,
              counts,
            },
          })
          nextTodoFingerprint = fingerprint
        }
        break
      }

      case "session.error": {
        const error = event.properties.error

        logs.push({
          level: "warning",
          message: "OpenCode reported a session error.",
          fields: {
            ...(error?.name ? { name: error.name } : {}),
            ...(error?.data && typeof error.data === "object" && "message" in error.data
              ? { errorMessage: truncateForLog(String(error.data.message), 200) }
              : {}),
          },
        })
        break
      }
    }
  }

  return {
    state: {
      lastStatusKey,
      toolStatesByCallId,
      seenRetryAttempts: [...seenRetryAttempts],
      todoFingerprint: nextTodoFingerprint,
      eventStreamFailed: state.eventStreamFailed,
    },
    logs,
  }
}

/**
 * Consumes the OpenCode SSE stream for a single session and emits concise
 * progress milestones. Stream failures are downgraded to warnings so the main
 * prompt path stays authoritative for correctness.
 */
export const runOpenCodeProgressLogger = ({
  events,
  sessionId,
}: {
  readonly events: AsyncIterable<OpenCodeEvent>
  readonly sessionId: string
}): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make(initialOpenCodeProgressState)

    yield* Stream.fromAsyncIterable(events, (error) => error).pipe(
      Stream.filter((event) => isOpenCodeProgressEventForSession(event, sessionId)),
      Stream.groupedWithin(32, "16 millis"),
      Stream.runForEach((batch) =>
        Ref.modify(stateRef, (state) => {
          const reduced = reduceOpenCodeProgressBatch(state, batch)
          return [reduced.logs, reduced.state] as const
        }).pipe(Effect.flatMap((logs) => Effect.forEach(logs, emitProgressLog, { discard: true }))),
      ),
      Effect.catch((error) =>
        Ref.modify(stateRef, (state) => {
          if (state.eventStreamFailed || isAbortError(error)) {
            return [false, state] as const
          }

          return [
            true,
            {
              ...state,
              eventStreamFailed: true,
            },
          ] as const
        }).pipe(
          Effect.flatMap((shouldLog) =>
            shouldLog
              ? logWarning("OpenCode event stream failed. Continuing without live progress updates.", {
                  detail: formatUnknownDetail(error),
                  sessionId,
                })
              : Effect.void,
          ),
        ),
      ),
    )
  })

const findAvailablePort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.unref()

      server.once("error", reject)
      server.listen(0, SERVER_HOST, () => {
        const address = server.address()

        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          if (!address || typeof address === "string") {
            reject(new Error("Failed to resolve the temporary localhost port for the OpenCode server."))
            return
          }

          resolve(address.port)
        })
      })
    }),
  catch: (error) =>
    toInvocationError({
      message: "Failed to allocate a localhost port for the OpenCode server.",
      detail: formatUnknownDetail(error),
    }),
})

const readReadyUrl = (line: string) => {
  const match = line.match(/opencode server listening.*\s(https?:\/\/[^\s]+)/i)
  return match?.[1]
}

const waitForServerUrl = (handle: ChildProcessHandle, timeout: Duration.Duration) =>
  handle.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.map((line) => readReadyUrl(line.trim())),
    Stream.filter((url): url is string => typeof url === "string"),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            toInvocationError({
              message: "OpenCode server exited before reporting a listening URL.",
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
    (effect) =>
      awaitWithin(effect, timeout, () =>
        toInvocationError({
          message: `Timed out waiting for the OpenCode server to start after ${Duration.format(timeout)}.`,
        }),
      ),
    Effect.mapError((error) =>
      error instanceof OpenCodeInvocationError
        ? error
        : toInvocationError({
            message: "Failed while waiting for the OpenCode server to start.",
            detail: formatUnknownDetail(error),
          }),
    ),
  )

const collectTextResponse = (parts: ReadonlyArray<Part> | undefined) =>
  (parts ?? [])
    .filter((part): part is Extract<Part, { readonly type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join("\n")
    .trim()

const toModelError = (error: AssistantMessage["error"]): OpenCodeModelError | undefined => {
  if (!error) {
    return undefined
  }

  const message =
    "data" in error && error.data && typeof error.data === "object" && "message" in error.data
      ? String(error.data.message)
      : error.name
  const retries =
    error.name === "StructuredOutputError" &&
    error.data &&
    typeof error.data === "object" &&
    "retries" in error.data &&
    typeof error.data.retries === "number"
      ? error.data.retries
      : undefined

  return {
    name: error.name,
    message,
    ...(retries !== undefined ? { retries } : {}),
  }
}

const toUsage = (message: AssistantMessage): OpenCodeRunUsage => {
  const tokens: OpenCodeRunTokens = {
    input: message.tokens.input,
    output: message.tokens.output,
    reasoning: message.tokens.reasoning,
    cacheRead: message.tokens.cache.read,
    cacheWrite: message.tokens.cache.write,
  }

  return {
    ...(message.cost !== undefined ? { costUsd: message.cost } : {}),
    tokens,
  }
}

const failForAssistantError = (error: NonNullable<AssistantMessage["error"]>) =>
  toOutputError(
    "OpenCode returned an assistant error.",
    stringifyJson({
      name: error.name,
      ...(error.data ? { data: error.data } : {}),
    }),
  )

const selectLatestAssistantReply = (
  messages: ReadonlyArray<{
    readonly info:
      | AssistantMessage
      | { readonly role: string; readonly time?: { readonly created?: number | undefined } | undefined }
    readonly parts: ReadonlyArray<Part>
  }>,
) =>
  messages
    .filter(
      (message): message is { readonly info: AssistantMessage; readonly parts: ReadonlyArray<Part> } =>
        message.info.role === "assistant",
    )
    .sort((left, right) => (right.info.time.created ?? 0) - (left.info.time.created ?? 0))[0]

const loadLatestAssistantReply = ({
  client,
  sessionId,
}: {
  readonly client: ReturnType<typeof createOpencodeClient>
  readonly sessionId: string
}) =>
  Effect.tryPromise({
    try: async () => {
      const [messagesResult, statusResult] = await Promise.all([
        client.session.messages<true>({
          sessionID: sessionId,
          limit: 20,
        }),
        client.session.status<true>(),
      ])
      const assistantReply =
        messagesResult.response.status === 200 && messagesResult.data
          ? selectLatestAssistantReply(
              messagesResult.data as ReadonlyArray<{ info: AssistantMessage; parts: ReadonlyArray<Part> }>,
            )
          : undefined

      return {
        assistantReply,
        status: statusResult.response.status === 200 && statusResult.data ? statusResult.data[sessionId] : undefined,
      }
    },
    catch: (error) => toOutputError("Failed to resolve the OpenCode assistant reply.", formatUnknownDetail(error)),
  })

const resolveAssistantReply = ({
  client,
  sessionId,
  response,
}: {
  readonly client: ReturnType<typeof createOpencodeClient>
  readonly sessionId: string
  readonly response: { readonly info?: AssistantMessage; readonly parts?: ReadonlyArray<Part> }
}): Effect.Effect<
  { readonly info: AssistantMessage; readonly parts: ReadonlyArray<Part> | undefined },
  OpenCodeOutputError
> =>
  response.info
    ? Effect.succeed({
        info: response.info,
        parts: response.parts,
      })
    : Effect.gen(function* () {
        while (true) {
          const { assistantReply, status } = yield* loadLatestAssistantReply({
            client,
            sessionId,
          })

          if (assistantReply) {
            return assistantReply
          }

          if (status?.type !== "busy" && status?.type !== "retry") {
            return yield* Effect.fail(
              toOutputError("OpenCode returned no assistant reply payload.", stringifyJson(response)),
            )
          }

          yield* Effect.sleep(Duration.millis(250))
        }
      })

export const decodePromptResult = ({
  info,
  parts,
}: {
  readonly info: AssistantMessage
  readonly parts: ReadonlyArray<Part> | undefined
}): Effect.Effect<OpenCodeSdkPromptResult, OpenCodeOutputError> => {
  const response = collectTextResponse(parts)
  const modelError = toModelError(info.error)
  const hasUsablePayload = response.length > 0 || info.structured !== undefined

  if (info.error && !hasUsablePayload) {
    return Effect.fail(failForAssistantError(info.error))
  }

  return Effect.succeed({
    response,
    ...(info.structured !== undefined ? { structured: info.structured } : {}),
    ...(modelError ? { modelError } : {}),
    sessionId: info.sessionID,
    ...(info.tokens ? { usage: toUsage(info) } : {}),
  })
}

const spawnServer = (request: OpenCodeSdkPromptRequest, spawner: ChildProcessSpawner["Service"]) =>
  Effect.gen(function* () {
    const port = yield* findAvailablePort
    const command = ChildProcess.make("opencode", ["serve", `--hostname=${SERVER_HOST}`, `--port=${port}`], {
      cwd: request.workspace,
      env: {
        ...request.inheritedEnv,
        OPENCODE_CONFIG_CONTENT: stringifyJson(request.config),
      },
      extendEnv: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })

    const handle = yield* spawner.spawn(command).pipe(
      Effect.mapError((error) =>
        toInvocationError({
          message: "Failed to start the OpenCode server.",
          detail: formatUnknownDetail(error),
        }),
      ),
    )
    const url = yield* waitForServerUrl(handle, request.timeout)

    return {
      handle,
      url,
    }
  })

const createSession = (
  client: ReturnType<typeof createOpencodeClient>,
  timeout: Duration.Duration,
): Effect.Effect<{ readonly id: string }, OpenCodeInvocationError> =>
  Effect.tryPromise({
    try: async () => {
      const result = await client.session.create<true>()

      if (result.response.status !== 200 || !result.data) {
        throw new Error(`Unexpected OpenCode session creation status: ${result.response.status}`)
      }

      return result.data
    },
    catch: (error) =>
      toInvocationError({
        message: "Failed to create the OpenCode session.",
        detail: formatUnknownDetail(error),
      }),
  }).pipe((effect) =>
    awaitWithin(effect, timeout, () =>
      toInvocationError({
        message: `Timed out creating the OpenCode session after ${Duration.format(timeout)}.`,
      }),
    ),
  )

/**
 * Opens the OpenCode event SSE subscription used for live progress reporting.
 *
 * The OpenCode SDK expects a native AbortSignal, so this boundary lets Effect
 * own cancellation for the async subscription handshake instead of introducing
 * a separate controller only to bridge into the foreign API.
 */
export const subscribeToOpenCodeEvents = ({ client }: { readonly client: OpenCodeEventClient }) =>
  Effect.tryPromise({
    try: (signal) => client.event.subscribe({}, { signal }),
    catch: (error) =>
      toInvocationError({
        message: "Failed to subscribe to the OpenCode event stream.",
        detail: formatUnknownDetail(error),
      }),
  })

/**
 * Runs an effect while a matching OpenCode event subscription is active for
 * the session, then guarantees the SDK stream and consumer fiber are both
 * cleaned up when the scoped Effect exits.
 *
 * Effect still owns cancellation for the async `event.subscribe()` call. The
 * extra lifetime controller exists only because the SDK exposes stream teardown
 * through AbortSignal rather than a close/dispose handle on the returned
 * subscription object.
 */
export const withOpenCodeProgressSubscription = <A, E, R>(
  {
    client,
    sessionId,
  }: {
    readonly client: OpenCodeEventClient
    readonly sessionId: string
  },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const streamLifetime = new AbortController()
      const subscription = yield* subscribeToOpenCodeEvents({
        client: withSubscriptionLifetime(client, streamLifetime.signal),
      }).pipe(
        Effect.catch((error) =>
          logWarning("OpenCode progress streaming is unavailable. Continuing without live milestones.", {
            detail: error.message,
            ...(error.stderr ? { stderr: truncateForLog(error.stderr, 200) } : {}),
            sessionId,
          }).pipe(Effect.as(undefined)),
        ),
      )

      if (!subscription) {
        return undefined
      }

      const fiber = yield* runOpenCodeProgressLogger({
        events: subscription.stream,
        sessionId,
      }).pipe(Effect.forkScoped)

      return {
        stop: () => streamLifetime.abort(),
        fiber,
      }
    }),
    (resource) =>
      resource
        ? Effect.gen(function* () {
            yield* Effect.sync(() => resource.stop()).pipe(ignoreFailure)
            yield* Fiber.interrupt(resource.fiber).pipe(ignoreFailure)
          })
        : Effect.void,
  ).pipe(
    Effect.flatMap(() => effect),
    Effect.scoped,
  )

const validatePromptModel = ({
  client,
  request,
}: {
  readonly client: ReturnType<typeof createOpencodeClient>
  readonly request: OpenCodeSdkPromptRequest
}): Effect.Effect<void, OpenCodeInvocationError | OpenCodeOutputError> =>
  Effect.tryPromise({
    try: async () => {
      const result = await client.provider.list<true>()

      if (result.response.status !== 200 || !result.data) {
        throw new Error(`Unexpected OpenCode provider list status: ${result.response.status}`)
      }

      const provider = result.data.all.find((entry) => entry.id === request.model.providerID)
      const providerDefaultModel = result.data.default[request.model.providerID]

      if (!provider) {
        throw toOutputError(
          `OpenCode provider "${request.model.providerID}" is not available.`,
          stringifyJson({
            providerID: request.model.providerID,
            connectedProviders: result.data.connected,
          }),
        )
      }

      if (request.model.modelID in provider.models) {
        return
      }

      throw toOutputError(
        `OpenCode provider "${request.model.providerID}" does not expose model "${request.model.modelID}".`,
        stringifyJson({
          providerID: request.model.providerID,
          requestedModelID: request.model.modelID,
          defaultModelID: providerDefaultModel,
          availableModelIDs: Object.keys(provider.models).slice(0, 20),
        }),
      )
    },
    catch: (error) =>
      error instanceof OpenCodeOutputError
        ? error
        : toInvocationError({
            message: "Failed while resolving available OpenCode provider models.",
            detail: formatUnknownDetail(error),
          }),
  }).pipe((effect) =>
    awaitWithin(effect, request.timeout, () =>
      toInvocationError({
        message: `Timed out resolving OpenCode provider models after ${Duration.format(request.timeout)}.`,
      }),
    ),
  )

const promptSession = ({
  client,
  sessionId,
  request,
}: {
  readonly client: ReturnType<typeof createOpencodeClient>
  readonly sessionId: string
  readonly request: OpenCodeSdkPromptRequest
}): Effect.Effect<OpenCodeSdkPromptResult, OpenCodeInvocationError | OpenCodeOutputError> =>
  validatePromptModel({
    client,
    request,
  }).pipe(
    Effect.flatMap(() =>
      withOpenCodeProgressSubscription(
        {
          client,
          sessionId,
        },
        Effect.tryPromise({
          try: async () => {
            const result = await client.session.prompt<true>({
              sessionID: sessionId,
              model: request.model,
              agent: request.agent,
              ...(request.variant ? { variant: request.variant } : {}),
              ...(request.format ? { format: request.format } : {}),
              parts: [
                {
                  type: "text",
                  text: request.prompt,
                },
              ],
            })

            if (result.response.status !== 200 || !result.data) {
              throw new Error(`Unexpected OpenCode prompt status: ${result.response.status}`)
            }

            return result.data
          },
          catch: (error) =>
            error instanceof OpenCodeOutputError
              ? error
              : toInvocationError({
                  message: "Failed while prompting OpenCode.",
                  detail: formatUnknownDetail(error),
                }),
        }),
      ),
    ),
    (effect) =>
      awaitWithin(effect, request.timeout, () =>
        toInvocationError({
          message: `Timed out waiting for the OpenCode prompt after ${Duration.format(request.timeout)}.`,
        }),
      ),
    Effect.flatMap((response) =>
      resolveAssistantReply({
        client,
        sessionId,
        response: response as { readonly info?: AssistantMessage; readonly parts?: ReadonlyArray<Part> },
      }),
    ),
    Effect.flatMap(decodePromptResult),
  )

const makeOpenCodeSdkRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner
  const prompt: OpenCodeSdkRuntime["Service"]["prompt"] = Effect.fn("OpenCodeSdkRuntime.prompt")(function* (request) {
    return yield* Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(spawnServer(request, spawner), ({ handle }) =>
        handle
          .kill({
            forceKillAfter: Duration.seconds(2),
          })
          .pipe(ignoreFailure),
      )
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: request.workspace,
      })
      const session = yield* createSession(client, request.timeout)
      yield* logInfo("Created OpenCode session.")
      yield* logInfo(getAssistantRunMessage(request))

      return yield* promptSession({
        client,
        sessionId: session.id,
        request,
      })
    }).pipe(Effect.scoped)
  })

  return {
    prompt,
  }
})

export const OpenCodeSdkRuntimeLive = Layer.effect(OpenCodeSdkRuntime, makeOpenCodeSdkRuntime)
