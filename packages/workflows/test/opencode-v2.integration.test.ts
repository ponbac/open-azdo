import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Duration, Effect, Layer } from "effect"

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

type MockStep =
  | { readonly tool: string; readonly input: Record<string, unknown> }
  | { readonly text: string }
  | { readonly status: number; readonly message: string }
  | { readonly hang: true }

const usageChunk = { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, choices: [] }

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

const toSse = (chunks: ReadonlyArray<unknown>) =>
  new Response([...chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`), "data: [DONE]\n\n"].join(""), {
    headers: { "content-type": "text/event-stream" },
  })

/** Minimal OpenAI-compatible chat endpoint that replays a scripted conversation. */
const startMockProvider = () => {
  let steps: Array<MockStep> = []
  const state = {
    requests: 0,
    script: (next: ReadonlyArray<MockStep>) => {
      steps = [...next]
      state.requests = 0
    },
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: () => {
      state.requests += 1
      const step = steps.shift() ?? { text: "Done." }

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
            usageChunk,
          ])
        : toSse([chunk({ role: "assistant", content: step.text }), chunk({}, "stop"), usageChunk])
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

const submit = (input: Record<string, unknown>) => ({ tool: "open_azdo_submit_result", input })

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
            settings: { baseURL: `http://127.0.0.1:${mock.server.port}/v1`, apiKey: "mock" },
            models: { "mock-1": { name: "Mock", limit: { context: 1_000_000, output: 4_000 } } },
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

  test("denies tools outside the read-only rules", async () => {
    mock.state.script([{ tool: "shell", input: { command: "touch escaped.txt" } }, submit(validResult)])

    await Effect.runPromise(run())

    expect(await Bun.file(join(workspace, "escaped.txt")).exists()).toBe(false)
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
