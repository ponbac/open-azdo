import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

import { Effect, Layer } from "effect"

import { OpenCodeInvocationError, OpenCodeOutputError } from "../../errors"
import { stringifyJson } from "../../Json"
import { logError, logInfo, truncateForLog } from "../../Logging"
import { ProcessRunner } from "../../process-runner"
import { OpenCodeRunner, type OpenCodeRunRequest } from "../Services/OpenCodeRunner"

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

const REVIEW_TRIGGER_MESSAGE = "Review the pull request using your configured instructions and return strict JSON only."

const buildOpenCodeArgs = (request: OpenCodeRunRequest) => [
  "run",
  "--format",
  "json",
  "--agent",
  request.agent,
  "--model",
  request.model,
  ...(request.variant ? ["--variant", request.variant] : []),
  REVIEW_TRIGGER_MESSAGE,
]

export const extractFinalResponse = (output: string) => {
  const texts: string[] = []
  const structuredCandidates: string[] = []

  const maybeCollectStructuredCandidate = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return
    }

    if ("summary" in value && "verdict" in value && "findings" in value) {
      structuredCandidates.push(JSON.stringify(value))
    }
  }

  const collectTextCandidates = (value: unknown): void => {
    if (!value) {
      return
    }

    if (typeof value === "string") {
      const trimmed = value.trim()
      if (!trimmed) {
        return
      }

      texts.push(trimmed)

      try {
        maybeCollectStructuredCandidate(JSON.parse(trimmed))
      } catch {
        // Ignore non-JSON text fragments.
      }

      return
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        collectTextCandidates(entry)
      }
      return
    }

    if (typeof value !== "object") {
      return
    }

    maybeCollectStructuredCandidate(value)

    if ("type" in value && value.type === "text" && "text" in value && typeof value.text === "string") {
      texts.push(value.text.trim())
    }

    for (const [key, nested] of Object.entries(value)) {
      if (
        (key === "text" ||
          key === "content" ||
          key === "message" ||
          key === "part" ||
          key === "parts" ||
          key === "delta" ||
          key === "textDelta" ||
          key === "response" ||
          key === "result" ||
          key === "data" ||
          key === "info") &&
        nested !== undefined
      ) {
        collectTextCandidates(nested)
      }
    }
  }

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
      collectTextCandidates(event)
    } catch {
      texts.push(trimmed)
    }
  }

  const structuredResponse = structuredCandidates.at(-1)?.trim()
  if (structuredResponse) {
    return structuredResponse
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

const makeOpenCodeRunner = Effect.gen(function* () {
  const runner = yield* ProcessRunner
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const run = Effect.fn("OpenCodeRunner.run")(function* (request: OpenCodeRunRequest) {
    return yield* Effect.gen(function* () {
      yield* logInfo("Preparing OpenCode execution.", {
        agent: request.agent,
        model: request.model,
        workspace: request.workspace,
        promptChars: request.prompt.length,
      })

      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "open-azdo-opencode-" }).pipe(
        Effect.mapError(
          (error) =>
            new OpenCodeOutputError({
              message: "Failed to create OpenCode temp directory.",
              output: String(error),
            }),
        ),
      )

      const configPath = path.join(tempDir, "opencode.json")
      const promptPath = path.join(tempDir, "agent-prompt.md")

      yield* Effect.all(
        [
          fileSystem.writeFileString(promptPath, request.prompt),
          fileSystem.writeFileString(configPath, stringifyJson(buildOpenCodeConfig(request.agent))),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (error) =>
            new OpenCodeOutputError({
              message: "Failed to write temporary OpenCode configuration.",
              output: String(error),
            }),
        ),
      )

      yield* logInfo("Prepared temporary OpenCode files.", {
        tempDir,
        configPath,
        promptPath,
      })

      const result = yield* runner
        .execute({
          operation: "OpenCodeRunner.run",
          command: "opencode",
          args: buildOpenCodeArgs(request),
          cwd: request.workspace,
          timeout: request.timeout,
          env: {
            ...request.inheritedEnv,
            OPENCODE_CONFIG: configPath,
            OPENCODE_CONFIG_DIR: tempDir,
          },
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OpenCodeInvocationError({
                message: error.detail,
                stderr: error.stderr,
                exitCode: error.exitCode,
              }),
          ),
        )

      yield* logInfo("OpenCode process exited.", {
        exitCode: result.exitCode,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
      })

      if (result.exitCode !== 0) {
        yield* logError("OpenCode exited with a non-zero status.", {
          exitCode: result.exitCode,
          stderrPreview: truncateForLog(result.stderr),
        })

        return yield* new OpenCodeInvocationError({
          message: "OpenCode exited with a non-zero status.",
          stderr: result.stderr,
          exitCode: result.exitCode,
        })
      }

      const response = yield* Effect.try({
        try: () => extractFinalResponse(result.stdout),
        catch: (error) =>
          error instanceof OpenCodeOutputError
            ? error
            : new OpenCodeOutputError({
                message: "OpenCode did not return a valid final response.",
                output: String(error),
              }),
      }).pipe(
        Effect.tapError((error) =>
          logError("Failed to extract final OpenCode response.", {
            stdoutPreview: truncateForLog(result.stdout),
            stderrPreview: truncateForLog(result.stderr),
            detail: error.message,
          }),
        ),
      )

      yield* logInfo("Extracted final OpenCode response.", {
        responseChars: response.length,
        responsePreview: truncateForLog(response),
      })

      return response
    }).pipe(Effect.scoped)
  })

  return {
    run,
  }
})

export const OpenCodeRunnerLive = Layer.effect(OpenCodeRunner, makeOpenCodeRunner)
