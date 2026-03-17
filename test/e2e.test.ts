import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { runCli } from "../src/cli"
import { createFixtureRepo, createTempDir, makeFetchMock } from "./helpers"

describe("e2e", () => {
  test("runs the CLI against a fixture repo and mocked Azure DevOps", async () => {
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
      if (url.endsWith("/pullRequests/42")) {
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
    globalThis.fetch = fetchMock as typeof fetch
    process.env.PATH = `${binDir}:${originalPath ?? ""}`

    try {
      const exitCode = await Effect.runPromise(
        runCli(
          [
            "review",
            "--model",
            "openai/gpt-5.4",
            "--workspace",
            repoDir,
            "--collection-url",
            "https://dev.azure.com/acme",
            "--project",
            "project",
            "--repository-id",
            "repo-1",
            "--pull-request-id",
            "42",
          ],
          {
            SYSTEM_ACCESSTOKEN: "system-token",
            SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/main",
            BUILD_SOURCESDIRECTORY: repoDir,
            SYSTEM_TEAMPROJECT: "project",
            BUILD_REPOSITORY_ID: "repo-1",
            SYSTEM_COLLECTIONURI: "https://dev.azure.com/acme",
            SYSTEM_PULLREQUEST_PULLREQUESTID: "42",
          },
        ),
      )

      expect(exitCode).toBe(0)
      expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
      process.env.PATH = originalPath
      await rm(binDir, { recursive: true, force: true })
      await rm(repoDir, { recursive: true, force: true })
    }
  })
})
