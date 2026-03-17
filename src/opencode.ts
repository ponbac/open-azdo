import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import type { ReviewConfig } from "./config"
import { OpenCodeInvocationError, OpenCodeOutputError } from "./errors"

export type SpawnLike = typeof Bun.spawn

export const runOpenCode = Effect.fn("opencode.runOpenCode")(function* (
  config: ReviewConfig,
  prompt: string,
  spawn: SpawnLike = Bun.spawn,
) {
  const tempDir = yield* Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "open-azdo-opencode-")),
    catch: (error) =>
      new OpenCodeOutputError({
        message: "Failed to create OpenCode temp directory.",
        output: String(error),
      }),
  })

  try {
    const configPath = join(tempDir, "opencode.json")
    const promptPath = join(tempDir, "agent-prompt.md")

    yield* Effect.tryPromise({
      try: async () => {
        await writeFile(promptPath, prompt, "utf8")
        await writeFile(configPath, JSON.stringify(buildOpenCodeConfig(config.agent), null, 2), "utf8")
      },
      catch: (error) =>
        new OpenCodeOutputError({
          message: "Failed to write temporary OpenCode configuration.",
          output: String(error),
        }),
    })

    const child = yield* Effect.try({
      try: () =>
        spawn(["opencode", "run", "--format", "json", "--agent", config.agent, "--model", config.model, prompt], {
          cwd: config.workspace,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            OPENCODE_CONFIG: configPath,
            OPENCODE_CONFIG_DIR: tempDir,
          },
        }),
      catch: (error) =>
        new OpenCodeInvocationError({
          message: "Failed to start OpenCode.",
          stderr: String(error),
          exitCode: -1,
        }),
    })

    const [stdout, stderr, exitCode] = yield* Effect.tryPromise({
      try: () => Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      catch: (error) =>
        new OpenCodeInvocationError({
          message: "Failed while waiting for OpenCode output.",
          stderr: String(error),
          exitCode: -1,
        }),
    })

    if (exitCode !== 0) {
      return yield* new OpenCodeInvocationError({
        message: "OpenCode exited with a non-zero status.",
        stderr,
        exitCode,
      })
    }

    return extractFinalResponse(stdout)
  } finally {
    yield* Effect.promise(() => rm(tempDir, { recursive: true, force: true }))
  }
})

export const buildOpenCodeConfig = (agentName: string) => ({
  $schema: "https://opencode.ai/config.json",
  permission: {
    edit: "deny",
    read: "allow",
    grep: "allow",
    list: "allow",
    glob: "allow",
    webfetch: "deny",
    websearch: "deny",
    codesearch: "deny",
    bash: {
      "*": "deny",
      "git diff *": "allow",
      "git show *": "allow",
      "git log *": "allow",
      "git status *": "allow",
      "git rev-parse *": "allow",
      "rg *": "allow",
      "grep *": "allow",
      "find *": "allow",
      "ls *": "allow",
      "cat *": "allow",
      "sed *": "allow",
    },
  },
  agent: {
    [agentName]: {
      mode: "primary",
      description: "Read-only Azure DevOps pull request reviewer",
      prompt: "{file:./agent-prompt.md}",
      permission: {
        edit: "deny",
        webfetch: "deny",
        websearch: "deny",
        codesearch: "deny",
      },
    },
  },
})

export const extractFinalResponse = (output: string) => {
  const texts: string[] = []

  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    try {
      const event = JSON.parse(trimmed)

      if (typeof event === "string") {
        texts.push(event)
        continue
      }

      if (typeof event.text === "string") {
        texts.push(event.text)
      }

      if (typeof event.content === "string") {
        texts.push(event.content)
      }

      if (Array.isArray(event.content)) {
        for (const part of event.content) {
          if (part && typeof part.text === "string") {
            texts.push(part.text)
          }
        }
      }
    } catch {
      texts.push(trimmed)
    }
  }

  const response = texts.join("\n").trim()
  if (!response) {
    throw new OpenCodeOutputError({
      message: "OpenCode did not return a final response.",
      output,
    })
  }

  return response
}
