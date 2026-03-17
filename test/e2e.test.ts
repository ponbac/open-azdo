import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import * as ConfigProvider from "effect/ConfigProvider"

import { executeReviewWithInput } from "../src/app/Cli"
import {
  createFixtureRepo,
  createMockFetch,
  createTempDir,
  makeBaseEnv,
  makeFetchMock,
  makeReviewCliInput,
} from "./helpers"

describe("e2e", () => {
  test("runs the review workflow against a fixture repo and mocked Azure DevOps", async () => {
    const { repoDir } = await createFixtureRepo()
    const binDir = await createTempDir("open-azdo-bin-")
    const opencodePath = join(binDir, "opencode")

    await mkdir(binDir, { recursive: true })
    await writeFile(
      opencodePath,
      `#!/usr/bin/env bash
printf '%s\n' '${JSON.stringify({
        text: JSON.stringify({
          summary: "Found one issue",
          verdict: "concerns",
          findings: [
            {
              severity: "high",
              confidence: "high",
              title: "Use the updated value",
              body: "The change introduces a new exported symbol.",
              filePath: "src/example.ts",
              line: 2,
            },
          ],
          unmappedNotes: [],
        }),
      })}'
`,
      "utf8",
    )
    await chmod(opencodePath, 0o755)

    const { fetchMock, calls } = makeFetchMock((url, init) => {
      if (url.endsWith("/pullRequests/42") && init?.method === "GET") {
        return Response.json({
          title: "Feature PR",
          description: "Adds a new export",
        })
      }

      if (url.endsWith("/threads?api-version=7.1") && init?.method === "GET") {
        return Response.json({ value: [] })
      }

      return Response.json({ id: calls.length })
    })

    const originalFetch = globalThis.fetch
    const originalPath = process.env.PATH
    const configEnv = {
      ...makeBaseEnv(),
      BUILD_SOURCESDIRECTORY: repoDir,
    }

    globalThis.fetch = createMockFetch(fetchMock, originalFetch)
    process.env.PATH = `${binDir}:${originalPath ?? ""}`

    try {
      const exitCode = await Effect.runPromise(
        executeReviewWithInput(
          makeReviewCliInput({
            model: Option.some("openai/gpt-5.4"),
            workspace: Option.some(repoDir),
            collectionUrl: Option.some("https://dev.azure.com/acme"),
            project: Option.some("project"),
            repositoryId: Option.some("repo-1"),
            pullRequestId: Option.some(42),
          }),
        ).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: configEnv,
              }),
            ),
          ),
        ),
      )

      expect(exitCode).toBe(0)
      expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch

      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }

      await rm(binDir, { recursive: true, force: true })
      await rm(repoDir, { recursive: true, force: true })
    }
  })
})
