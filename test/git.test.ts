import { rm } from "node:fs/promises"

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { resolvePullRequestDiff, compressChangedLines, extractHunkHeaders } from "../src/git/PullRequestDiff"
import { GitExec } from "../src/git/Services/GitExec"
import {
  createFixtureRepo,
  createSyntheticMergeRepo,
  makeGitExec,
  makeGitExecLayer,
  makeRealGitExecLayer,
} from "./helpers"

describe("git", () => {
  test("compresses changed lines into contiguous ranges", () => {
    expect(compressChangedLines(new Set([3, 4, 5, 9, 10, 14]))).toEqual([
      { start: 3, end: 5 },
      { start: 9, end: 10 },
      { start: 14, end: 14 },
    ])
  })

  test("extracts hunk headers from a patch", () => {
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,3 +1,5 @@",
      " export const value = 1",
      "@@ -10,2 +12,4 @@ export function next() {",
      " }",
    ].join("\n")

    expect(extractHunkHeaders(patch)).toEqual(["@@ -1,3 +1,5 @@", "@@ -10,2 +12,4 @@ export function next() {"])
  })

  test("resolves synthetic merge commits against HEAD^1", async () => {
    const { repoDir } = await createSyntheticMergeRepo()

    try {
      const diff = await Effect.runPromise(
        resolvePullRequestDiff({
          workspace: repoDir,
          targetBranch: "refs/heads/main",
        }).pipe(Effect.provide(makeRealGitExecLayer())),
      )

      expect(diff.baseRef).toBe("HEAD^1")
      expect(diff.changedFiles).toContain("src/example.ts")
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("fails clearly when target history is unavailable", async () => {
    const { repoDir } = await createFixtureRepo()

    try {
      const exit = await Effect.runPromiseExit(
        resolvePullRequestDiff({
          workspace: repoDir,
          targetBranch: undefined,
        }).pipe(Effect.provide(makeRealGitExecLayer())),
      )

      expect(exit._tag).toBe("Failure")
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("executes git via argv arrays instead of shell strings", async () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = []

    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitExec
        yield* git.execute({
          operation: "Git.test",
          cwd: "/tmp",
          args: ["status", "--short"],
        })
      }).pipe(
        Effect.provide(
          makeGitExecLayer(
            makeGitExec((input) => {
              calls.push({
                command: "git",
                args: input.args,
              })

              return Effect.succeed({
                exitCode: 0,
                stdout: "",
                stderr: "",
              })
            }),
          ),
        ),
      ),
    )

    expect(calls[0]).toEqual({
      command: "git",
      args: ["status", "--short"],
    })
  })
})
