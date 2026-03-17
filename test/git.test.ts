import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { resolveGitDiff, runGit } from "../src/git"
import { createSyntheticMergeRepo, makeReviewConfig } from "./helpers"

describe("git", () => {
  test("resolves synthetic merge commits against HEAD^1", async () => {
    const { repoDir } = await createSyntheticMergeRepo()
    const config = makeReviewConfig({
      workspace: repoDir,
      targetBranch: "refs/heads/main",
    })

    const diff = await Effect.runPromise(resolveGitDiff(config))

    expect(diff.baseRef).toBe("HEAD^1")
    expect(diff.changedFiles).toContain("src/example.ts")
  })

  test("fails clearly when target history is unavailable", async () => {
    const config = makeReviewConfig({
      workspace: await Bun.write(Bun.file("/tmp/open-azdo-dummy"), "").then(() => "/tmp"),
      targetBranch: undefined,
    })

    const exit = await Effect.runPromiseExit(resolveGitDiff(config))
    expect(exit._tag).toBe("Failure")
  })

  test("uses argv arrays instead of shell strings", async () => {
    const calls: Array<{ argv: string[] }> = []
    const spawn = ((argv: string[]) => {
      calls.push({ argv })

      return {
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
        exited: Promise.resolve(0),
      }
    }) as typeof Bun.spawn

    await Effect.runPromise(runGit("/tmp", ["status", "--short"], spawn, true))

    expect(calls[0]?.argv).toEqual(["git", "status", "--short"])
  })
})
