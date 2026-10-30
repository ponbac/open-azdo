import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Duration, Effect, Layer, Result, type Schema } from "effect"

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
  | { readonly status: number; readonly message: string; readonly code?: string }
  | { readonly hang: true }
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

/** Minimal OpenAI-compatible chat endpoint that replays a scripted conversation. */
const startMockProvider = () => {
  let steps: Array<MockStep> = []

  const state = {
    requests: 0,
    requestBodies: new Array<string>(),
    authorizations: new Array<string | null>(),
    script: (next: ReadonlyArray<MockStep>) => {
      steps = [...next]
      state.requests = 0
      state.requestBodies.length = 0
      state.authorizations.length = 0
    },
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      state.requests += 1
      state.requestBodies.push(await request.text())
      state.authorizations.push(request.headers.get("authorization"))
      const step = steps.shift() ?? { text: "Done." }

      if ("hang" in step) {
        return new Promise<Response>(() => undefined)
      }

      if ("status" in step) {
        return Response.json(
          { error: { message: step.message, type: "mock", code: step.code } },
          { status: step.status },
        )
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
    "sed -i s/hello/PWNED/ permission-sentinel.txt",
    "git diff --output=permission-output.txt",
    "cat /proc/self/environ",
  ])(
    "denies model shell command %s",
    async (command) => {
      await writeFile(join(workspace, "permission-sentinel.txt"), "hello\n")
      await rm(join(workspace, "permission-output.txt"), { force: true })
      mock.state.script([{ tool: "shell", input: { command } }, submit(validResult)])

      await Effect.runPromise(run())

      expect(mock.state.requestBodies.some((body) => body.includes("No tool named"))).toBe(true)
      expect(await Bun.file(join(workspace, "permission-sentinel.txt")).text()).toBe("hello\n")
      expect(await Bun.file(join(workspace, "permission-output.txt")).exists()).toBe(false)
    },
    60_000,
  )

  test("omits Azure job credentials from the real server environment while preserving provider credentials", async () => {
    mock.state.script([submit(validResult)])

    await Effect.runPromise(run())

    expect(mock.state.authorizations.length).toBeGreaterThan(0)
    expect(mock.state.authorizations.every((header) => header === "Bearer provider-sentinel::::")).toBe(true)
  }, 60_000)

  test.each([
    {
      scenario: "before the oversized prompt reaches the model",
      model: "mock/compact-1",
      prompt: "scoped patch line\n".repeat(60_000),
      prefix: new Array<MockStep>(),
    },
    {
      scenario: "after the provider rejects the context length",
      model: "mock/mock-1",
      prompt: "scoped patch line\n".repeat(60_000),
      prefix: [
        { status: 400, message: "Input exceeds the model's maximum context length", code: "context_length_exceeded" },
      ] satisfies MockStep[],
    },
    {
      scenario: "mid-run after a repository read exhausts the model context",
      model: "mock/compact-1",
      prompt: "Scoped patch evidence must survive this review.\n".repeat(100),
      prefix: [{ tool: "read", input: { path: "example.txt" }, inputTokens: 45_000 }] satisfies MockStep[],
    },
  ])(
    "fails if compaction starts $scenario",
    async ({ model, prompt, prefix }) => {
      mock.state.script([
        ...prefix,
        {
          text: [
            "## Objective",
            "- Review the change.",
            "## Requirements",
            "- (none)",
            "## Decisions",
            "- (none)",
            "## Work State",
            "### Completed",
            "- Read the request.",
            "### Active",
            "- Submit the review.",
            "### Blocked",
            "- (none)",
            "## Next Move",
            "1. Submit the review.",
            "## Relevant Files",
            "- (none)",
            "## Important Context",
            "- (none)",
          ].join("\n"),
        },
        submit(validResult),
        { text: "Done." },
      ])

      const result = await Effect.runPromise(run({ model, prompt }).pipe(Effect.result))

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(OpenCodeOutputError)
        expect(result.failure.message).toContain("compaction")
      }
    },
    60_000,
  )

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
