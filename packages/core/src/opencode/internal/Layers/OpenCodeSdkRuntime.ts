import { createServer } from "node:net"

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"

import { Duration, Effect, Layer, Option, Stream } from "effect"

import { OpenCodeInvocationError, OpenCodeOutputError } from "../../../errors"
import { formatUnknownDetail } from "../../../format-unknown"
import { stringifyJson } from "../../../Json"
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

const awaitWithin = <A, E>(
  effect: Effect.Effect<A, E>,
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

const collectTextResponse = (parts: ReadonlyArray<Part>) =>
  parts
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

export const decodePromptResult = ({
  info,
  parts,
}: {
  readonly info: AssistantMessage
  readonly parts: ReadonlyArray<Part>
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

const promptSession = ({
  client,
  sessionId,
  request,
}: {
  readonly client: ReturnType<typeof createOpencodeClient>
  readonly sessionId: string
  readonly request: OpenCodeSdkPromptRequest
}): Effect.Effect<OpenCodeSdkPromptResult, OpenCodeInvocationError | OpenCodeOutputError> =>
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
  }).pipe(
    (effect) =>
      awaitWithin(effect, request.timeout, () =>
        toInvocationError({
          message: `Timed out waiting for the OpenCode prompt after ${Duration.format(request.timeout)}.`,
        }),
      ),
    Effect.flatMap((response) =>
      decodePromptResult({
        info: response.info as AssistantMessage,
        parts: response.parts,
      }),
    ),
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
