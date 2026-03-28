import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import * as Duration from "effect/Duration"

import { SandboxCaptureSchema } from "@open-azdo/sandbox/capture"

const requiredEnv = [
  "OPEN_AZDO_LIVE_MODEL",
  "OPEN_AZDO_LIVE_COLLECTION_URL",
  "OPEN_AZDO_LIVE_PROJECT",
  "OPEN_AZDO_LIVE_REPOSITORY_ID",
  "OPEN_AZDO_LIVE_PULL_REQUEST_ID",
  "OPEN_AZDO_LIVE_ACCESS_TOKEN",
]

const hasLiveConfig = requiredEnv.every((name) => {
  const value = process.env[name]
  return typeof value === "string" && value.length > 0
})

const DEFAULT_LIVE_TIMEOUT = Duration.minutes(10)
const LIVE_TEST_BUFFER = Duration.minutes(2)

const resolveLiveTimeout = () => {
  const value = process.env.OPEN_AZDO_LIVE_OPENCODE_TIMEOUT?.trim()
  if (!value) {
    return DEFAULT_LIVE_TIMEOUT
  }

  const duration = Option.getOrUndefined(Duration.fromInput(value as Duration.Input))
  return duration && Duration.isFinite(duration) && Duration.isPositive(duration) ? duration : DEFAULT_LIVE_TIMEOUT
}

const LIVE_TEST_TIMEOUT_MS = Duration.toMillis(resolveLiveTimeout()) + Duration.toMillis(LIVE_TEST_BUFFER)

describe.if(hasLiveConfig)("sandbox live integration", () => {
  test(
    "captures a real PR into a sanitized sandbox artifact",
    async () => {
      const project = process.env.OPEN_AZDO_LIVE_PROJECT ?? ""
      const repositoryId = process.env.OPEN_AZDO_LIVE_REPOSITORY_ID ?? ""
      const pullRequestId = Number(process.env.OPEN_AZDO_LIVE_PULL_REQUEST_ID ?? "0")
      const output = join(tmpdir(), `open-azdo-live-${Date.now()}.json`)
      const processResult = Bun.spawnSync(
        ["bun", "run", "./bin/open-azdo.ts", "sandbox", "capture", "--output", output],
        {
          cwd: import.meta.dir.replace(/\/test$/, ""),
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        },
      )

      expect(processResult.exitCode).toBe(0)

      const text = await readFile(output, "utf8")
      const capture = Schema.decodeUnknownSync(SandboxCaptureSchema)(JSON.parse(text))
      const token = process.env.OPEN_AZDO_LIVE_ACCESS_TOKEN ?? ""

      expect(capture.target.project).toBe(project)
      expect(capture.target.repositoryId).toBe(repositoryId)
      expect(capture.target.pullRequestId).toBe(pullRequestId)
      expect(capture.review.prompt?.length ?? 0).toBeGreaterThan(0)
      expect(capture.review.actions.length).toBeGreaterThanOrEqual(1)
      expect(capture.review.previewThreads.length).toBeGreaterThanOrEqual(capture.baselineThreads.length)
      expect(text.includes(token)).toBe(false)
    },
    LIVE_TEST_TIMEOUT_MS,
  )
})
