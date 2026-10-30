import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Duration, Effect, Layer, Schema, Option } from "effect"

import { BaseRuntimeLayer } from "@open-azdo/core/base-runtime"
import { OpenCodeInvocationError, OpenCodeOutputError } from "@open-azdo/core/errors"
import { OpenCodeRunner, OpenCodeRunnerLive, type OpenCodeRunRequest } from "@open-azdo/core/opencode"

import { ReviewResultJsonSchema } from "../src/review/ReviewOutput"

/**
 * Protocol compatibility check against a real OpenCode binary. Point
 * OPEN_AZDO_OPENCODE_BIN at the pinned release to run it. All model traffic
 * goes to a local mock, and HOME and XDG paths are isolated from the host.
 */
const binary = process.env.OPEN_AZDO_OPENCODE_BIN

type MockStep = (
  | { readonly tool: string; readonly input: Record<string, Schema.Json> }
  | { readonly text: string }
  | { readonly status: number; readonly message: string }
  | { readonly hang: true }
  | { readonly recoverTask: true }
) & { readonly inputTokens?: number }

const usageChunk = (inputTokens = 11) => ({
  usage: { prompt_tokens: inputTokens, completion_tokens: 7, total_tokens: inputTokens + 7 },
  choices: [],
})

const chunk = (delta: Record<string, Schema.Json>, finishReason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

const toSse = (chunks: ReadonlyArray<Schema.Json>) =>
  new Response([...chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`), "data: [DONE]\n\n"].join(""), {
    headers: { "content-type": "text/event-stream" },
  })

const ChatRequest = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      content: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})

const decodeChatRequest = Schema.decodeUnknownSync(Schema.fromJsonString(ChatRequest))

const taskFileFromSystem = (request: typeof ChatRequest.Type) => {
  const system = request.messages
    .flatMap((message) => (message.role === "system" && message.content ? [message.content] : []))
    .join("\n")

  const path = /^Task file: (.+)$/mu.exec(system)?.[1]

  return path
    ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))(path))
    : undefined
}

/** Minimal OpenAI-compatible chat endpoint that replays a scripted conversation. */
const startMockProvider = () => {
  let steps: Array<MockStep> = []

  const state = {
    requests: 0,
    transcripts: new Array<typeof ChatRequest.Type>(),
    authorizations: new Array<string | null>(),
    script: (next: ReadonlyArray<MockStep>) => {
      steps = [...next]
      state.requests = 0
      state.transcripts.length = 0
      state.authorizations.length = 0
    },
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      state.requests += 1
      const transcript = decodeChatRequest(await request.text())
      state.transcripts.push(transcript)
      state.authorizations.push(request.headers.get("authorization"))
      const scriptedStep = steps.shift() ?? { text: "Done." }
      const taskPath = taskFileFromSystem(transcript)

      const step: Exclude<MockStep, { readonly recoverTask: true }> =
        "recoverTask" in scriptedStep
          ? taskPath
            ? { tool: "read", input: { path: taskPath } }
            : { text: "No task recovery instructions were provided." }
          : scriptedStep

      if ("hang" in step) {
        return new Promise<Response>(() => undefined)
      }

      if ("status" in step) {
        return Response.json({ error: { message: step.message, type: "mock" } }, { status: step.status })
      }

      return "tool" in step
        ? toSse([
            chunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${state.requests}`,
                  type: "function",
                  function: { name: step.tool, arguments: JSON.stringify(step.input) },
                },
              ],
            }),
            chunk({}, "tool_calls"),
            usageChunk(step.inputTokens),
          ])
        : toSse([chunk({ role: "assistant", content: step.text }), chunk({}, "stop"), usageChunk(step.inputTokens)])
    },
  })

  return { state, server }
}

const validResult = {
  verdict: "pass",
  findings: [],
  resolvedManagedFindingIds: [],
  unmappedNotes: [],
}

const submit = (input: Record<string, Schema.Json>) => ({ tool: "open_azdo_submit_result", input })

describe.skipIf(!binary)("OpenCode V2 runtime", () => {
  const mock = startMockProvider()
  let root: string
  let workspace: string
  let inheritedEnv: NodeJS.ProcessEnv

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "open-azdo-opencode-v2-"))
    workspace = join(root, "workspace")
    await mkdir(workspace, { recursive: true })
    await mkdir(join(root, "config/opencode"), { recursive: true })
    await writeFile(join(workspace, "example.txt"), "hello\n")
    await Bun.$`git init -q`.cwd(workspace)

    // The provider stays in the isolated global config so the runtime's generated config is exercised unchanged.
    await writeFile(
      join(root, "config/opencode/opencode.json"),
      JSON.stringify({
        providers: {
          mock: {
            name: "Mock",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: {
              baseURL: `http://127.0.0.1:${mock.server.port}/v1`,
              apiKey:
                "{env:OPEN_AZDO_PROVIDER_SENTINEL}:{env:SYSTEM_ACCESSTOKEN}:{env:OPEN_AZDO_LIVE_ACCESS_TOKEN}:{env:system_accesstoken}:{env:open_azdo_live_access_token}",
            },
            models: {
              "mock-1": { name: "Mock", limit: { context: 1_000_000, output: 4_000 } },
              "compact-1": { name: "Compact", limit: { context: 50_000, output: 4_000 } },
            },
          },
        },
      }),
    )

    inheritedEnv = {
      PATH: `${dirname(binary ?? "")}${delimiter}${process.env.PATH}`,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPEN_AZDO_PROVIDER_SENTINEL: "provider-sentinel",
      SYSTEM_ACCESSTOKEN: "system-token-sentinel",
      OPEN_AZDO_LIVE_ACCESS_TOKEN: "live-token-sentinel",
      system_accesstoken: "lowercase-system-token-sentinel",
      open_azdo_live_access_token: "lowercase-live-token-sentinel",
    }
  })

  afterAll(async () => {
    await mock.server.stop(true)
    await rm(root, { recursive: true, force: true })
  })

  const run = (overrides: Partial<OpenCodeRunRequest> = {}) =>
    Effect.gen(function* () {
      const runner = yield* OpenCodeRunner

      return yield* runner.run({
        workspace,
        model: "mock/mock-1",
        agent: "azdo-review",
        variant: undefined,
        timeout: Duration.seconds(30),
        prompt: "Review this pull request.",
        inheritedEnv,
        format: { type: "json_schema", schema: ReviewResultJsonSchema },
        ...overrides,
      })
    }).pipe(Effect.provide(OpenCodeRunnerLive.pipe(Layer.provide(BaseRuntimeLayer))), Effect.provide(BaseRuntimeLayer))

  test("returns a corrected submission that many later steps pushed down the history", async () => {
    mock.state.script([
      submit({ verdict: "not-a-verdict" }),
      submit(validResult),
      // More steps than one page of assistant history.
      ...Array.from({ length: 51 }, () => ({ tool: "read", input: { path: "example.txt" } })),
      { text: "Done." },
    ])

    const result = await Effect.runPromise(run())

    expect(result.structured).toEqual(validResult)
    expect(result.response).toBe("Done.")
    expect(result.usage?.tokens?.input).toBe(11 * 54)
  }, 60_000)

  test("returns text when the model never calls the submission tool", async () => {
    const text = JSON.stringify(validResult)
    mock.state.script([{ text }])

    const result = await Effect.runPromise(run())

    expect(result.structured).toBeUndefined()
    expect(result.response).toBe(text)
  }, 60_000)

  test("keeps a submission when the following model call fails", async () => {
    mock.state.script([submit(validResult), { status: 400, message: "Context too long" }])

    const result = await Effect.runPromise(run())

    expect(result.structured).toEqual(validResult)
    expect(result.modelError?.message).toBe("Context too long")
  }, 60_000)

  test.each([
    {
      command: "bash -lc 'grep -qx hello example.txt && printf bash-verification-ok'",
      expected: "bash-verification-ok",
    },
    {
      command: `python3 -c 'from pathlib import Path; assert Path("example.txt").read_text() == "hello\\n"; print("python-verification-ok")'`,
      expected: "python-verification-ok",
    },
  ])(
    "allows workspace verification with $expected",
    async ({ command, expected }) => {
      mock.state.script([{ tool: "shell", input: { command } }, submit(validResult)])

      const result = await Effect.runPromise(run())

      expect(result.structured).toEqual(validResult)
      expect(
        mock.state.transcripts.some((request) =>
          request.messages.some((message) => message.role === "tool" && message.content?.includes(expected)),
        ),
      ).toBe(true)
    },
    60_000,
  )

  test("omits Azure job credentials from the real server environment while preserving provider credentials", async () => {
    mock.state.script([submit(validResult)])

    await Effect.runPromise(run())

    expect(mock.state.authorizations.length).toBeGreaterThan(0)
    expect(mock.state.authorizations.every((header) => header === "Bearer provider-sentinel::::")).toBe(true)
  }, 60_000)

  test("recovers the original task through native read after mid-run compaction", async () => {
    const prompt = "Original task scope sentinel: inspect example.txt and submit a review for the exact supplied refs."
    mock.state.script([
      { tool: "read", input: { path: "example.txt" }, inputTokens: 45_000 },
      { text: "## Objective\n- Continue reviewing.\n\n## Next Move\n1. Recover the original task." },
      { recoverTask: true },
      submit(validResult),
      { text: "Done." },
    ])

    const result = await Effect.runPromise(run({ model: "mock/compact-1", prompt }))

    const afterCompaction = mock.state.transcripts.filter((request) =>
      request.messages.some((message) => message.content?.includes("<conversation-checkpoint>")),
    )

    const taskPath = taskFileFromSystem(mock.state.transcripts[0] ?? { messages: [] })

    expect(result.structured).toEqual(validResult)
    expect(afterCompaction.length).toBeGreaterThan(0)
    expect(afterCompaction.every((request) => taskFileFromSystem(request) === taskPath)).toBe(true)
    expect(
      afterCompaction.every((request) =>
        request.messages.some(
          (message) =>
            message.role === "system" && message.content?.includes("You are an AI agent running in OpenCode"),
        ),
      ),
    ).toBe(true)
    expect(
      afterCompaction.some((request) =>
        request.messages.some(
          (message) =>
            message.role === "tool" &&
            message.content?.includes(prompt) &&
            message.content.includes("open_azdo_submit_result"),
        ),
      ),
    ).toBe(true)
    expect(taskPath).toBeDefined()

    if (taskPath) expect(await Bun.file(taskPath).exists()).toBe(false)
  }, 60_000)

  test("provides and cleans a recoverable task file for text requests", async () => {
    const prompt = "Text task scope sentinel: inspect example.txt and explain the result."
    mock.state.script([{ recoverTask: true }, { text: "Text task complete." }])

    const result = await Effect.runPromise(run({ prompt, format: { type: "text" } }))
    const taskPath = taskFileFromSystem(mock.state.transcripts[0] ?? { messages: [] })

    expect(result.response).toBe("Text task complete.")
    expect(
      mock.state.transcripts[0]?.messages.some(
        (message) => message.role === "system" && message.content?.includes("You are an AI agent running in OpenCode"),
      ),
    ).toBe(true)
    expect(
      mock.state.transcripts.some((request) =>
        request.messages.some((message) => message.role === "tool" && message.content?.includes(prompt)),
      ),
    ).toBe(true)
    expect(taskPath).toBeDefined()

    if (taskPath) expect(await Bun.file(taskPath).exists()).toBe(false)
  }, 60_000)

  test("fails provider errors without a usable payload", async () => {
    mock.state.script([{ status: 401, message: "Invalid API key" }])

    const failure = await Effect.runPromise(run().pipe(Effect.flip))

    expect(failure).toBeInstanceOf(OpenCodeOutputError)
    expect(failure.message).toBe("OpenCode returned an assistant error.")
  }, 60_000)

  test("rejects models the server does not expose", async () => {
    mock.state.script([])

    const failure = await Effect.runPromise(run({ model: "mock/missing" }).pipe(Effect.flip))

    expect(failure.message).toBe('OpenCode provider "mock" does not expose model "missing".')
    expect(mock.state.requests).toBe(0)
  }, 60_000)

  test("does not leave a timed-out review for a managed service to resume", async () => {
    mock.state.script([{ hang: true }])

    // Inline config is gone after the run, so only an agent the service also knows can actually resume.
    const failure = await Effect.runPromise(run({ agent: "build", timeout: Duration.seconds(2) }).pipe(Effect.flip))

    expect(failure).toBeInstanceOf(OpenCodeInvocationError)
    expect(failure.message).toContain("Timed out waiting for the OpenCode prompt")

    const taskPath = taskFileFromSystem(mock.state.transcripts[0] ?? { messages: [] })

    expect(taskPath).toBeDefined()

    if (taskPath) expect(await Bun.file(taskPath).exists()).toBe(false)

    // Only the managed service resumes unreleased execution claims at boot, private servers never do.
    mock.state.script([])

    const service = Bun.spawn(["opencode", "serve", "--service", "--hostname=127.0.0.1", "--port=0"], {
      cwd: workspace,
      env: inheritedEnv,
      stdout: "ignore",
      stderr: "ignore",
    })

    await Bun.sleep(3_000)
    service.kill()
    await service.exited

    expect(mock.state.requests).toBe(0)
  }, 60_000)
})
