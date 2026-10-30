import { randomBytes } from "node:crypto"
import { join } from "node:path"

import { OpenCode } from "@opencode/client"
import type {
  EventSubscribeOutput,
  OpenCodeClient,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageIdle,
  SessionStructuredError,
  SessionToolCalled,
  MessageListInput,
  SessionCreateInput,
} from "@opencode/client"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner, type ChildProcessHandle } from "effect/process/ChildProcessSpawner"
import * as FileSystem from "effect/FileSystem"

import { Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Ref, Schema, Stream, type Types } from "effect"

import { OpenCodeInvocationError, OpenCodeOutputError } from "../../../errors"
import { formatUnknownDetail } from "../../../format-unknown"
import { logInfo, logWarning, truncateForLog } from "../../../Logging"
import {
  withoutAzureDevOpsCredentials,
  type OpenCodeModelError,
  type OpenCodeRunTokens,
  type OpenCodeRunUsage,
} from "../../Services/OpenCodeRunner"
import {
  OPEN_CODE_STRUCTURED_OUTPUT_TOOL,
  OpenCodeSdkRuntime,
  type OpenCodeConfig,
  type OpenCodeSdkPromptRequest,
  type OpenCodeSdkPromptResult,
} from "../Services/OpenCodeSdkRuntime"

const SERVER_HOST = "127.0.0.1"
const SERVER_USERNAME = "opencode"
const SERVER_OUTPUT_TAIL_LINES = 20
const SESSION_TITLE = "open-azdo review"
const IDLE_POLL_INTERVAL = Duration.millis(250)
const ASSISTANT_PAGE_SIZE = 50

/** Live progress is optional, so a stalled event stream may only delay the prompt briefly. */
const PROGRESS_CONNECT_TIMEOUT = Duration.seconds(5)
const INTERRUPT_SETTLE_TIMEOUT = Duration.seconds(2)

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

type OpenCodeEvent = EventSubscribeOutput

/** The event adapter needs only a cancellable subscription, not the client's unrelated event APIs. */
type OpenCodeEventClient = {
  readonly event: {
    readonly subscribe: (options: { readonly signal: AbortSignal }) => AsyncIterable<OpenCodeEvent>
  }
}

type OpenCodeProgressLog = {
  readonly level: "info" | "warning"
  readonly message: string
  readonly fields?: {
    readonly attempt?: number
    readonly nextDelayMs?: number
    readonly retryMessage?: string
    readonly tool?: string
    readonly callId?: string
    readonly title?: string
    readonly error?: string
    readonly name?: string
    readonly errorMessage?: string
    readonly detail?: string
    readonly sessionId?: string
    readonly stderr?: string
  }
}

type OpenCodeToolProgressState = {
  readonly name: string
  readonly title?: string | undefined
  readonly started: boolean
}

/** Immutable progress snapshot keyed by SDK tool-call identity for one active session. */
export type OpenCodeProgressState = {
  readonly toolStatesByCallId: ReadonlyMap<string, OpenCodeToolProgressState>
  readonly seenRetryAttempts: ReadonlyArray<number>
  readonly eventStreamFailed: boolean
}

/** Empty snapshot copied by each batch reduction; the shared map is never mutated. */
export const initialOpenCodeProgressState: OpenCodeProgressState = {
  toolStatesByCallId: new Map(),
  seenRetryAttempts: [],
  eventStreamFailed: false,
}

const isAbortError = (cause: unknown) =>
  cause instanceof Error &&
  (cause.name === "AbortError" ||
    cause.message.includes("abort") ||
    cause.message.includes("aborted") ||
    cause.message.includes("The operation was aborted"))

const emitProgressLog = (entry: OpenCodeProgressLog) =>
  entry.level === "warning" ? logWarning(entry.message, entry.fields) : logInfo(entry.message, entry.fields)

const TOOL_TITLE_INPUT_KEYS = ["title", "filePath", "command", "query", "pattern", "path", "url"] as const

/** Read the SDK's arbitrary tool input only through the supported string-title boundary. */
const titleFromToolInput = (input: SessionToolCalled["data"]["input"]) => {
  for (const key of TOOL_TITLE_INPUT_KEYS) {
    const candidate = Schema.decodeUnknownOption(Schema.String)(input[key])

    if (Option.isSome(candidate) && candidate.value.trim().length > 0) {
      return candidate.value.trim()
    }
  }

  return undefined
}

const getToolProgressIcon = (toolName: string) => {
  switch (toolName) {
    case "shell":
      return "🔧"
    case "read":
      return "📖"
    case "glob":
      return "✱"
    case "grep":
      return "🔎"
    default:
      return "⚙️"
  }
}

const getToolProgressMessage = (phase: "started" | "failed", tool: OpenCodeToolProgressState) => {
  const title = tool.title ? truncateForLog(tool.title, 160) : undefined
  const icon = getToolProgressIcon(tool.name)

  switch (phase) {
    case "started":
      return title ? `${icon} ${title}` : `${icon} ${tool.name}`
    case "failed":
      return title ? `⚠️ ${tool.name}: ${title}` : `⚠️ ${tool.name}`
  }
}

const getAssistantRunMessage = (request: OpenCodeSdkPromptRequest) =>
  request.variant
    ? `Starting OpenCode assistant run with ${request.model.modelID} (${request.variant}).`
    : "Starting OpenCode assistant run."

const getEventSessionId = (event: OpenCodeEvent): string | undefined => {
  switch (event.type) {
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
    case "session.retry.scheduled":
    case "session.tool.input.started":
    case "session.tool.called":
    case "session.tool.failed":
      return event.data.sessionID
    default:
      return undefined
  }
}

export const isOpenCodeProgressEventForSession = (event: OpenCodeEvent, sessionId: string) =>
  getEventSessionId(event) === sessionId

/** The next progress snapshot and its newly observed logs, applied together by the stream consumer. */
interface OpenCodeProgressBatch {
  readonly state: OpenCodeProgressState
  readonly logs: ReadonlyArray<OpenCodeProgressLog>
}

/**
 * Collapses noisy OpenCode events into a small per-session progress model and
 * a concise log stream that is readable in terminals and CI logs.
 *
 * Tool events carry the name and input separately, so the name is remembered
 * from `session.tool.input.started` for the later `called` and `failed` logs.
 */
export const reduceOpenCodeProgressBatch = (
  state: OpenCodeProgressState,
  events: ReadonlyArray<OpenCodeEvent>,
): OpenCodeProgressBatch => {
  const logs: OpenCodeProgressLog[] = []
  const seenRetryAttempts = new Set(state.seenRetryAttempts)

  const toolStatesByCallId = new Map(state.toolStatesByCallId)

  for (const event of events) {
    switch (event.type) {
      case "session.execution.started":
        logs.push({ level: "info", message: "OpenCode assistant is working." })
        break

      case "session.execution.succeeded":
        logs.push({ level: "info", message: "OpenCode assistant is idle." })
        break

      case "session.retry.scheduled":
        if (!seenRetryAttempts.has(event.data.attempt)) {
          seenRetryAttempts.add(event.data.attempt)
          logs.push({
            level: "info",
            message: "OpenCode is retrying the assistant response.",
            fields: {
              attempt: event.data.attempt,
              nextDelayMs: Math.max(0, event.data.at - event.created),
              retryMessage: truncateForLog(event.data.error.message, 160),
            },
          })
        }

        break

      case "session.tool.input.started":
        toolStatesByCallId.set(event.data.id, { name: event.data.name, started: false })
        break

      case "session.tool.called": {
        const previous = toolStatesByCallId.get(event.data.id)

        const tool = {
          name: previous?.name ?? "tool",
          title: titleFromToolInput(event.data.input),
          started: true,
        }

        if (!previous?.started) {
          logs.push({ level: "info", message: getToolProgressMessage("started", tool) })
        }

        toolStatesByCallId.set(event.data.id, tool)
        break
      }

      case "session.tool.failed": {
        const tool = toolStatesByCallId.get(event.data.id) ?? { name: "tool", started: true }

        const fields: Types.Mutable<NonNullable<OpenCodeProgressLog["fields"]>> = {
          tool: tool.name,
          callId: event.data.id,
          error: truncateForLog(event.data.error.message, 200),
        }

        if (tool.title) fields.title = tool.title

        logs.push({ level: "warning", message: getToolProgressMessage("failed", tool), fields })
        break
      }

      case "session.execution.failed":
        logs.push({
          level: "warning",
          message: "OpenCode reported a session error.",
          fields: {
            name: event.data.error.type,
            errorMessage: truncateForLog(event.data.error.message, 200),
          },
        })
        break
    }
  }

  return {
    state: {
      toolStatesByCallId,
      seenRetryAttempts: [...seenRetryAttempts],
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

const ServerReadyLine = Schema.fromJsonString(Schema.Struct({ url: Schema.String }))

const readReadyUrl = (line: string) =>
  Schema.decodeUnknownOption(ServerReadyLine)(line).pipe(Option.map(({ url }) => url))

/**
 * Waits for the `--stdio` ready line while draining server output for the
 * rest of the server's life, because a full pipe would block the server. A
 * bounded tail of the output explains early exits.
 */
const waitForServerUrl = (handle: ChildProcessHandle, timeout: Duration.Duration) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<string, OpenCodeInvocationError>()
    const tail = yield* Ref.make<ReadonlyArray<string>>([])

    yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Option.match(readReadyUrl(line.trim()), {
          onNone: () => Ref.update(tail, (lines) => [...lines, line].slice(-SERVER_OUTPUT_TAIL_LINES)),
          onSome: (url) => Deferred.succeed(ready, url),
        }),
      ),
      Effect.ignore,
      Effect.andThen(Ref.get(tail)),
      Effect.flatMap((lines) =>
        Deferred.fail(
          ready,
          toInvocationError({
            message: "OpenCode server exited before reporting a listening URL.",
            detail: lines.join("\n"),
          }),
        ),
      ),
      Effect.forkScoped,
    )

    return yield* awaitWithin(Deferred.await(ready), timeout, () =>
      toInvocationError({
        message: `Timed out waiting for the OpenCode server to start after ${Duration.format(timeout)}.`,
      }),
    )
  })

const collectTextResponse = (message: SessionMessageAssistant | undefined) =>
  (message?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .filter((text) => text.length > 0)
    .join("\n")
    .trim()

const toModelError = (error: SessionStructuredError | undefined): OpenCodeModelError | undefined =>
  error ? { name: error.type, message: error.message } : undefined

const toUsage = (session: SessionInfo): OpenCodeRunUsage => {
  const tokens: OpenCodeRunTokens = {
    input: session.tokens.input,
    output: session.tokens.output,
    reasoning: session.tokens.reasoning,
    cacheRead: session.tokens.cache.read,
    cacheWrite: session.tokens.cache.write,
  }

  return { costUsd: session.cost, tokens }
}

// `response.body` is left out on purpose: provider bodies can echo request data.
const failForAssistantError = (error: SessionStructuredError) =>
  toOutputError("OpenCode returned an assistant error.", JSON.stringify({ name: error.type, message: error.message }))

/** Select the SDK's last completed JSON submission; the workflow owns review/summary schema validation. */
const findSubmittedResult = (message: SessionMessageAssistant) => {
  const submitted = message.content
    .filter(
      (part): part is SessionMessageAssistantTool =>
        part.type === "tool" && part.name === OPEN_CODE_STRUCTURED_OUTPUT_TOOL,
    )
    .findLast((part) => part.state.status === "completed")?.state.input

  return submitted
}

/**
 * Reads the finished turn's newest assistant message and, when a structured
 * result is wanted, the newest completed submission. A submission does not end
 * V2's model loop, so it can sit many steps behind the newest message and the
 * assistant history has to be followed backward until one turns up.
 */
const loadAssistantTurn = ({
  client,
  sessionId,
  wantsSubmission,
}: {
  readonly client: OpenCodeClient
  readonly sessionId: string
  readonly wantsSubmission: boolean
}) =>
  Effect.tryPromise({
    try: async (signal) => {
      let latest: SessionMessageAssistant | undefined
      let structured: Schema.Json | undefined
      let cursor: string | null | undefined

      do {
        const input: Types.Mutable<MessageListInput> = {
          sessionID: sessionId,
          type: "assistant",
          limit: ASSISTANT_PAGE_SIZE,
        }

        if (cursor) input.cursor = cursor
        else input.order = "desc"

        const page = await client.message.list(input, { signal })

        const messages = page.data.filter((message) => message.type === "assistant")

        latest ??= messages[0]
        structured = messages.map(findSubmittedResult).find((input) => input !== undefined)
        cursor = page.data.length === ASSISTANT_PAGE_SIZE ? page.cursor.next : undefined
      } while (wantsSubmission && structured === undefined && cursor)

      const session = await client.session.get({ sessionID: sessionId }, { signal })

      return { latest, structured, session }
    },
    catch: (error) => toOutputError("Failed to resolve the OpenCode assistant reply.", formatUnknownDetail(error)),
  })

const loadIdleMessage = (client: OpenCodeClient, sessionId: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const page = await client.message.list(
        { sessionID: sessionId, type: "idle", order: "desc", limit: 1 },
        { signal },
      )

      return page.data.find((message) => message.type === "idle")
    },
    catch: (error) =>
      toInvocationError({
        message: "Failed while waiting for the OpenCode session to finish.",
        detail: formatUnknownDetail(error),
      }),
  })

/** Poll persisted completion messages independently of the optional live progress stream. */
const awaitIdleMessage = (client: OpenCodeClient, sessionId: string) =>
  Effect.gen(function* () {
    while (true) {
      const idle = yield* loadIdleMessage(client, sessionId)

      if (idle) {
        return idle
      }

      yield* Effect.sleep(IDLE_POLL_INTERVAL)
    }
  })

/**
 * Decodes a finished turn. Usable text or a submitted result survives a later provider error;
 * task recovery after context compaction is guided by the run's persistent instruction file.
 */
export const decodePromptResult = ({
  sessionId,
  latest,
  structured,
  idle,
  usage,
}: {
  readonly sessionId: string
  readonly latest: SessionMessageAssistant | undefined
  readonly structured: Schema.Json | undefined
  readonly idle: SessionMessageIdle
  readonly usage: OpenCodeRunUsage
}): Effect.Effect<OpenCodeSdkPromptResult, OpenCodeInvocationError | OpenCodeOutputError> => {
  const response = collectTextResponse(latest)
  const error = latest?.error ?? idle.error
  const modelError = toModelError(error)

  if (response.length === 0 && structured === undefined) {
    if (idle.outcome === "interrupted") {
      return Effect.fail(toInvocationError({ message: "The OpenCode session was interrupted." }))
    }

    if (error) {
      return Effect.fail(failForAssistantError(error))
    }

    if (!latest) {
      return Effect.fail(toOutputError("OpenCode returned no assistant reply payload.", JSON.stringify(idle)))
    }
  }

  const result: Types.Mutable<OpenCodeSdkPromptResult> = { response, sessionId, usage }

  if (structured !== undefined) result.structured = structured

  if (modelError) result.modelError = modelError

  return Effect.succeed(result)
}

/**
 * Dependency-free server plugin that registers the structured output tool.
 * Its JSON Schema `input` gives the model the same validate-and-correct loop as
 * V1's native `format` option, and the validated input is read back from the
 * assistant message.
 */
const STRUCTURED_OUTPUT_PLUGIN_SOURCE = `export default {
  id: "open-azdo.structured-output",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: ${JSON.stringify(OPEN_CODE_STRUCTURED_OUTPUT_TOOL)},
        description: "Submit the final result. Call this exactly once, as your last action.",
        input: ctx.options.schema,
        options: { codemode: false },
        execute: async () => ({ content: "Result recorded. End your turn now." }),
      })
    })
  },
}
`

const STRUCTURED_OUTPUT_PROMPT = [
  `Submit your final result by calling the \`${OPEN_CODE_STRUCTURED_OUTPUT_TOOL}\` tool exactly once as your last action, passing the complete result object as its input.`,
  "Do not repeat the result as text afterwards. Only if that tool is unavailable, reply with the result as JSON text instead.",
].join(" ")

/**
 * Keep the complete task and a short recovery instruction in the run-owned directory. OpenCode
 * reloads configured instruction files independently of compacted conversation history, alongside
 * its ordinary agent system prompt. The same scope owns these files and the output plugin.
 */
const prepareTask = Effect.fn("OpenCodeSdkRuntime.prepareTask")(
  function* (request: OpenCodeSdkPromptRequest, fileSystem: FileSystem.FileSystem) {
    const agent = request.config.agents[request.agent]

    if (!agent) {
      return yield* toInvocationError({
        message: `OpenCode agent "${request.agent}" is missing from the run configuration.`,
      })
    }

    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "open-azdo-opencode-" })
    const taskPath = join(directory, "task.md")
    const recoveryPath = join(directory, "recovery.md")

    const recovery = [
      `Task file: ${JSON.stringify(taskPath)}`,
      "Read this file before starting. After compaction, read it again as needed to recover the original task, scope, and output requirements.",
    ].join("\n")

    const config: Types.Mutable<OpenCodeConfig> = {
      ...request.config,
      instructions: [...(request.config.instructions ?? []), recoveryPath],
      agents: {
        ...request.config.agents,
        [request.agent]: {
          ...agent,
          permissions: [
            ...agent.permissions,
            { action: "external_directory", resource: `${directory.replaceAll("\\", "/")}/*`, effect: "allow" },
          ],
        },
      },
    }

    let prompt = request.prompt

    if (request.format?.type === "json_schema") {
      yield* fileSystem.writeFileString(join(directory, "index.js"), STRUCTURED_OUTPUT_PLUGIN_SOURCE)
      config.plugins = [
        ...(request.config.plugins ?? []),
        { package: directory, options: { schema: request.format.schema } },
      ]
      prompt = `${prompt}\n\n${STRUCTURED_OUTPUT_PROMPT}`
    }

    yield* fileSystem.writeFileString(taskPath, prompt)
    yield* fileSystem.writeFileString(recoveryPath, recovery)

    return { config, prompt }
  },
  (effect) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof OpenCodeInvocationError
          ? error
          : toInvocationError({
              message: "Failed to prepare the OpenCode task and output plugin.",
              detail: formatUnknownDetail(error),
            }),
      ),
    ),
)

/**
 * Starts this run's private server. `--stdio` takes a free port, removes the
 * password from the environment tools inherit, and ties the server's lifetime
 * to the stdin pipe held here, so it also exits if this process dies.
 */
const spawnServer = (
  request: OpenCodeSdkPromptRequest,
  config: OpenCodeConfig,
  spawner: ChildProcessSpawner["Service"],
) =>
  Effect.gen(function* () {
    const password = randomBytes(32).toString("base64url")

    const command = ChildProcess.make("opencode", ["serve", "--stdio", `--hostname=${SERVER_HOST}`, "--port=0"], {
      cwd: request.workspace,
      env: {
        // Library callers can supply their own environment, so enforce the same credential policy here.
        ...withoutAzureDevOpsCredentials(request.inheritedEnv),
        OPENCODE_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      extendEnv: false,
      stdin: "pipe",
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
      authorization: `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString("base64")}`,
    }
  })

const createSession = (
  client: OpenCodeClient,
  request: OpenCodeSdkPromptRequest,
): Effect.Effect<SessionInfo, OpenCodeInvocationError> =>
  Effect.tryPromise({
    try: (signal) => {
      const model: Types.Mutable<NonNullable<SessionCreateInput["model"]>> = {
        id: request.model.modelID,
        providerID: request.model.providerID,
      }

      if (request.variant) model.variant = request.variant

      return client.session.create(
        {
          // A preset title also skips OpenCode's title generation model call.
          title: SESSION_TITLE,
          agent: request.agent,
          model,
          location: { directory: request.workspace },
        },
        { signal },
      )
    },
    catch: (error) =>
      toInvocationError({
        message: "Failed to create the OpenCode session.",
        detail: formatUnknownDetail(error),
      }),
  }).pipe((effect) =>
    awaitWithin(effect, request.timeout, () =>
      toInvocationError({
        message: `Timed out creating the OpenCode session after ${Duration.format(request.timeout)}.`,
      }),
    ),
  )

/**
 * Stops the session before its server goes away. Shutdown alone is not a
 * cancellation: V2 keeps the execution claim so a later server on the same data
 * directory would resume the review. Interruption settles asynchronously, hence
 * the bounded wait for idle.
 */
const interruptSession = (client: OpenCodeClient, sessionId: string) =>
  Effect.tryPromise((signal) => client.session.interrupt({ sessionID: sessionId }, { signal })).pipe(
    Effect.flatMap(({ interrupted }) => (interrupted ? awaitIdleMessage(client, sessionId) : Effect.void)),
    Effect.timeoutOption(INTERRUPT_SETTLE_TIMEOUT),
    ignoreFailure,
  )

/**
 * Opens the OpenCode event subscription used for live progress reporting and
 * waits for its `server.connected` marker. The subscription is lazy and has no
 * replay, so it must be connected before prompting to observe the whole turn.
 *
 * `lifetime` ends an established stream, while the Effect signal cancels the
 * handshake itself.
 */
export const subscribeToOpenCodeEvents = ({
  client,
  lifetime,
}: {
  readonly client: OpenCodeEventClient
  readonly lifetime: AbortSignal
}): Effect.Effect<AsyncIterable<OpenCodeEvent>, OpenCodeInvocationError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const events = client.event.subscribe({ signal: AbortSignal.any([signal, lifetime]) })
      const iterator = events[Symbol.asyncIterator]()
      const connected = await iterator.next()

      if (connected.done) {
        throw new Error("The OpenCode event stream ended before connecting.")
      }

      return { [Symbol.asyncIterator]: () => iterator }
    },
    catch: (error) =>
      toInvocationError({
        message: "Failed to subscribe to the OpenCode event stream.",
        detail: formatUnknownDetail(error),
      }),
  }).pipe((effect) =>
    awaitWithin(effect, PROGRESS_CONNECT_TIMEOUT, () =>
      toInvocationError({
        message: `Timed out connecting to the OpenCode event stream after ${Duration.format(PROGRESS_CONNECT_TIMEOUT)}.`,
      }),
    ),
  )

/**
 * Runs an effect while a matching OpenCode event subscription is active for
 * the session, then guarantees the stream and consumer fiber are both cleaned
 * up when the scoped Effect exits.
 *
 * Effect owns cancellation for the subscription handshake. The extra lifetime
 * controller exists only because the client exposes stream teardown through
 * AbortSignal rather than a close/dispose handle on the returned iterable.
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

      const events = yield* subscribeToOpenCodeEvents({
        client,
        lifetime: streamLifetime.signal,
      }).pipe(
        Effect.catch((error) => {
          const fields: Types.Mutable<NonNullable<OpenCodeProgressLog["fields"]>> = { detail: error.message, sessionId }

          if (error.stderr) fields.stderr = truncateForLog(error.stderr, 200)

          return logWarning(
            "OpenCode progress streaming is unavailable. Continuing without live milestones.",
            fields,
          ).pipe(Effect.as(undefined))
        }),
      )

      if (!events) {
        return undefined
      }

      const fiber = yield* runOpenCodeProgressLogger({
        events,
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
  readonly client: OpenCodeClient
  readonly request: OpenCodeSdkPromptRequest
}): Effect.Effect<void, OpenCodeInvocationError | OpenCodeOutputError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const { data: models } = await client.model.list({ location: { directory: request.workspace } }, { signal })
      const providerModels = models.filter((model) => model.providerID === request.model.providerID)

      if (providerModels.length === 0) {
        throw toOutputError(
          `OpenCode provider "${request.model.providerID}" is not available.`,
          JSON.stringify({
            providerID: request.model.providerID,
            connectedProviders: [...new Set(models.map((model) => model.providerID))],
          }),
        )
      }

      if (providerModels.some((model) => model.id === request.model.modelID)) {
        return
      }

      throw toOutputError(
        `OpenCode provider "${request.model.providerID}" does not expose model "${request.model.modelID}".`,
        JSON.stringify({
          providerID: request.model.providerID,
          requestedModelID: request.model.modelID,
          availableModelIDs: providerModels.map((model) => model.id).slice(0, 20),
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
  prompt,
}: {
  readonly client: OpenCodeClient
  readonly sessionId: string
  readonly request: OpenCodeSdkPromptRequest
  readonly prompt: string
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
        // V2 prompting only enqueues the turn, so the reply is awaited separately.
        Effect.tryPromise({
          try: (signal) => client.session.prompt({ sessionID: sessionId, text: prompt }, { signal }),
          catch: (error) =>
            toInvocationError({
              message: "Failed while prompting OpenCode.",
              detail: formatUnknownDetail(error),
            }),
        }).pipe(Effect.andThen(awaitIdleMessage(client, sessionId))),
      ),
    ),
    Effect.flatMap((idle) =>
      loadAssistantTurn({
        client,
        sessionId,
        wantsSubmission: request.format?.type === "json_schema",
      }).pipe(
        Effect.flatMap(({ latest, structured, session }) =>
          decodePromptResult({ sessionId, latest, structured, idle, usage: toUsage(session) }),
        ),
      ),
    ),
    (effect) =>
      awaitWithin(effect, request.timeout, () =>
        toInvocationError({
          message: `Timed out waiting for the OpenCode prompt after ${Duration.format(request.timeout)}.`,
        }),
      ),
  )

const makeOpenCodeSdkRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner
  const fileSystem = yield* FileSystem.FileSystem

  const prompt: OpenCodeSdkRuntime["Service"]["prompt"] = Effect.fn("OpenCodeSdkRuntime.prompt")(function* (request) {
    return yield* Effect.gen(function* () {
      const { config, prompt } = yield* prepareTask(request, fileSystem)

      const server = yield* Effect.acquireRelease(spawnServer(request, config, spawner), ({ handle }) =>
        handle
          .kill({
            forceKillAfter: Duration.seconds(2),
          })
          .pipe(ignoreFailure),
      )

      const client = OpenCode.make({
        baseUrl: server.url,
        headers: { authorization: server.authorization },
      })

      // Released before the server, so a failed or cancelled turn is stopped while it is still reachable.
      const session = yield* Effect.acquireRelease(createSession(client, request), (session, exit) =>
        Exit.isSuccess(exit) ? Effect.void : interruptSession(client, session.id),
      )

      yield* logInfo("Created OpenCode session.")
      yield* logInfo(getAssistantRunMessage(request))

      return yield* promptSession({
        client,
        sessionId: session.id,
        request,
        prompt,
      })
    }).pipe(Effect.scoped)
  })

  return {
    prompt,
  }
})

export const OpenCodeSdkRuntimeLive = Layer.effect(OpenCodeSdkRuntime, makeOpenCodeSdkRuntime)
