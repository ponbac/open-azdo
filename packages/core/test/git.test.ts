import { rm } from "node:fs/promises"

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import {
  GitExec,
  compressChangedLines,
  extractHunkHeaders,
  isAncestor,
  resolveDiffRange,
  resolvePullRequestDiff,
  resolveReviewedSourceCommit,
} from "@open-azdo/core/git"
import {
  createDeletedFileFollowUpRepo,
  createDeletionFollowUpRepo,
  createFixtureRepo,
  createSyntheticMergeRepo,
  makeGitExec,
  makeGitExecLayer,
  makeRealGitExecLayer,
  withSilentLogs,
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
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(diff.baseRef).toBe("HEAD^1")
      expect(diff.changedFiles).toContain("src/example.ts")
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("resolves the reviewed source commit from HEAD for non-merge checkouts", async () => {
    const { repoDir, featureSha } = await createFixtureRepo()

    try {
      const reviewedSourceCommit = await Effect.runPromise(
        resolveReviewedSourceCommit({
          workspace: repoDir,
          sourceCommitId: undefined,
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(reviewedSourceCommit).toBe(featureSha)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("resolves the reviewed source commit from HEAD^2 for synthetic merge checkouts", async () => {
    const { repoDir, featureSha } = await createSyntheticMergeRepo()

    try {
      const reviewedSourceCommit = await Effect.runPromise(
        resolveReviewedSourceCommit({
          workspace: repoDir,
          sourceCommitId: undefined,
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(reviewedSourceCommit).toBe(featureSha)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("prefers the explicit source commit id when provided", async () => {
    const { repoDir, mainSha } = await createFixtureRepo()

    try {
      const reviewedSourceCommit = await Effect.runPromise(
        resolveReviewedSourceCommit({
          workspace: repoDir,
          sourceCommitId: mainSha,
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(reviewedSourceCommit).toBe(mainSha)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("resolves explicit diff ranges", async () => {
    const { repoDir, mainSha, featureSha } = await createFixtureRepo()

    try {
      const diff = await Effect.runPromise(
        resolveDiffRange({
          workspace: repoDir,
          baseRef: mainSha,
          headRef: featureSha,
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(diff.baseRef).toBe(mainSha)
      expect(diff.headRef).toBe(featureSha)
      expect(diff.changedFiles).toEqual(["src/example.ts"])
      expect(diff.deletedLinesByFile).toEqual(new Map([["src/example.ts", new Set([1])]]))
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("tracks deletion-only follow-up lines separately from reviewable changed lines", async () => {
    const { repoDir, reviewedSha, headSha } = await createDeletionFollowUpRepo()

    try {
      const diff = await Effect.runPromise(
        resolveDiffRange({
          workspace: repoDir,
          baseRef: reviewedSha,
          headRef: headSha,
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(diff.changedFiles).toEqual(["src/example.ts"])
      expect(diff.changedLinesByFile.get("src/example.ts") ?? new Set()).toEqual(new Set<number>())
      expect(diff.deletedLinesByFile).toEqual(new Map([["src/example.ts", new Set([2])]]))
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("tracks removed lines when a whole file is deleted", async () => {
    const { repoDir, reviewedSha, headSha } = await createDeletedFileFollowUpRepo()

    try {
      const diff = await Effect.runPromise(
        resolveDiffRange({
          workspace: repoDir,
          baseRef: reviewedSha,
          headRef: headSha,
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(diff.changedFiles).toEqual([])
      expect(diff.changedLinesByFile).toEqual(new Map())
      expect(diff.deletedLinesByFile).toEqual(new Map([["src/obsolete.ts", new Set([1])]]))
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("checks ancestor relationships across commits", async () => {
    const { repoDir, mainSha, featureSha } = await createFixtureRepo()

    try {
      const mainIsAncestor = await Effect.runPromise(
        isAncestor({
          workspace: repoDir,
          ancestorRef: mainSha,
          headRef: featureSha,
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      const featureIsAncestor = await Effect.runPromise(
        isAncestor({
          workspace: repoDir,
          ancestorRef: featureSha,
          headRef: mainSha,
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(mainIsAncestor).toBe(true)
      expect(featureIsAncestor).toBe(false)
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
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
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
