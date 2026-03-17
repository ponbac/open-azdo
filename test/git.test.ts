import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { resolveGitDiff, runGit } from "../src/git"
import { createSyntheticMergeRepo, makeGitTestLayer, makeReviewConfig } from "./helpers"

describe("git", () => {
  test("resolves synthetic merge commits against HEAD^1", async () => {
    const { repoDir } = await createSyntheticMergeRepo()
    const config = makeReviewConfig({
      workspace: repoDir,
      targetBranch: "refs/heads/main",
    })

    const diff = await Effect.runPromise(resolveGitDiff(config).pipe(Effect.provide(makeGitTestLayer())))

    expect(diff.baseRef).toBe("HEAD^1")
    expect(diff.changedFiles).toContain("src/example.ts")
  })

  test("fails clearly when target history is unavailable", async () => {
    const config = makeReviewConfig({
      workspace: await Bun.write(Bun.file("/tmp/open-azdo-dummy"), "").then(() => "/tmp"),
      targetBranch: undefined,
    })

    const exit = await Effect.runPromiseExit(resolveGitDiff(config).pipe(Effect.provide(makeGitTestLayer())))
    expect(exit._tag).toBe("Failure")
  })

  test("uses argv arrays instead of shell strings", async () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = []

    await Effect.runPromise(
      runGit("/tmp", ["status", "--short"], true).pipe(
        Effect.provide(
          makeGitTestLayer({
            execute: (input) => {
              calls.push({ command: input.command, args: input.args })
              return Effect.succeed({
                exitCode: 0,
                stdout: "",
                stderr: "",
              })
            },
          }),
        ),
      ),
    )

    expect(calls[0]).toEqual({
      command: "git",
      args: ["status", "--short"],
    })
  })
})
