import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { describe, expect, test } from "bun:test"
import { Duration, Effect, Layer } from "effect"

import { MissingGitHistoryError } from "@open-azdo/core/errors"
import { ProcessRunner, type ExecuteCommandInput } from "@open-azdo/core/process-runner"

import {
  GitExec,
  GitExecLive,
  compressChangedLines,
  extractHunkHeaders,
  extractChangedLinesByFile,
  hasTargetMergeCommitInRange,
  isAncestor,
  resolveDiffRange,
  resolvePullRequestDiff,
  resolveReviewedSourceCommit,
  splitDiffByFile,
  type ExecuteGitInput,
} from "@open-azdo/core/git"
import {
  createDeletedFileFollowUpRepo,
  createDeletionFollowUpRepo,
  createFixtureRepo,
  createSyntheticMergeRepo,
  createTargetMergeFollowUpRepo,
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
    const { repoDir, mainSha } = await createSyntheticMergeRepo()

    try {
      const diff = await Effect.runPromise(
        resolvePullRequestDiff({
          workspace: repoDir,
          targetBranch: "refs/heads/main",
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(diff.baseRef).toBe(mainSha)
      expect(diff.changedFiles).toContain("src/example.ts")
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("resolves source-branch merges against the parent that matches the target branch", async () => {
    const { repoDir, targetSha } = await createTargetMergeFollowUpRepo()

    try {
      const diff = await Effect.runPromise(
        resolvePullRequestDiff({
          workspace: repoDir,
          targetBranch: "refs/heads/main",
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(diff.baseRef).toBe(targetSha)
      expect(diff.changedFiles).toEqual(["src/example.ts"])
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

  test("falls back to HEAD^2 when the explicit source commit id is not available locally", async () => {
    const { repoDir, featureSha } = await createSyntheticMergeRepo()

    try {
      const reviewedSourceCommit = await Effect.runPromise(
        resolveReviewedSourceCommit({
          workspace: repoDir,
          sourceCommitId: "1111111111111111111111111111111111111111",
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(reviewedSourceCommit).toBe(featureSha)
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

      const empty = await Effect.runPromise(
        resolveDiffRange({ workspace: repoDir, baseRef: featureSha, headRef: featureSha }).pipe(
          Effect.provide(makeRealGitExecLayer()),
          withSilentLogs,
        ),
      )

      expect(empty.changedFiles).toEqual([])
      expect(empty.deletedFiles).toEqual([])
      expect(empty.renamedFromByFile).toEqual(new Map())
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("collects a real diff above one megabyte with bounded diff-specific command options", async () => {
    const { repoDir } = await createFixtureRepo()
    const lines = 8192
    const calls: ExecuteGitInput[] = []

    try {
      await writeFile(join(repoDir, "src/large.txt"), "old ".repeat(31).concat("\n").repeat(lines))
      await Bun.$`git add .`.cwd(repoDir).quiet()
      await Bun.$`git commit -m large-base`.cwd(repoDir).quiet()
      const baseRef = (await Bun.$`git rev-parse HEAD`.cwd(repoDir).quiet()).text().trim()

      await writeFile(join(repoDir, "src/large.txt"), "new ".repeat(31).concat("\n").repeat(lines))
      await Bun.$`git commit -am large-head`.cwd(repoDir).quiet()

      const diff = await Effect.runPromise(
        Effect.gen(function* () {
          const live = yield* GitExec

          return yield* resolveDiffRange({ workspace: repoDir, baseRef, headRef: "HEAD" }).pipe(
            Effect.provideService(
              GitExec,
              GitExec.of({
                execute: (input) => {
                  calls.push(input)

                  return live.execute(input)
                },
              }),
            ),
          )
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(Buffer.byteLength(diff.diffText)).toBeGreaterThan(1_000_000)
      expect(diff.changedLinesByFile.get("src/large.txt")?.size).toBe(lines)
      expect(diff.deletedLinesByFile.get("src/large.txt")?.size).toBe(lines)
      expect(calls).toHaveLength(2)

      for (const call of calls) {
        expect(call.timeout).toEqual(Duration.minutes(2))
        expect(call.maxOutputBytes).toBe(64 * 1024 * 1024)
      }
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("inventories every changed path including changes without right-side text hunks", async () => {
    const { repoDir } = await createFixtureRepo()
    const pureSource = Array.from({ length: 30 }, (_, i) => `pure line ${i}`).join("\n")
    const editedSource = Array.from({ length: 30 }, (_, i) => `edited line ${i}`)

    try {
      await writeFile(join(repoDir, ".gitattributes"), "suppressed.txt -diff\n")
      await writeFile(join(repoDir, "ordinary.txt"), "before\n")
      await writeFile(join(repoDir, "modified.bin"), new Uint8Array([0, 1, 2]))
      await writeFile(join(repoDir, "suppressed.txt"), "before\n")
      await writeFile(join(repoDir, "mode-only.sh"), "echo unchanged\n")
      await writeFile(join(repoDir, "pure-old.ts"), pureSource)
      await writeFile(join(repoDir, "edited-old.ts"), `${editedSource.join("\n")}\n`)
      await Bun.$`git add .`.cwd(repoDir).quiet()
      await Bun.$`git commit -m inventory-base`.cwd(repoDir).quiet()
      const baseRef = (await Bun.$`git rev-parse HEAD`.cwd(repoDir).quiet()).text().trim()

      await writeFile(join(repoDir, "ordinary.txt"), "after\n")
      await writeFile(join(repoDir, "added.bin"), new Uint8Array([0, 9, 10]))
      await writeFile(join(repoDir, "modified.bin"), new Uint8Array([0, 3, 4]))
      await writeFile(join(repoDir, "empty.txt"), "")
      await writeFile(join(repoDir, "suppressed.txt"), "after\n")
      await chmod(join(repoDir, "mode-only.sh"), 0o755)
      await rename(join(repoDir, "pure-old.ts"), join(repoDir, "pure-new.ts"))
      await rename(join(repoDir, "edited-old.ts"), join(repoDir, "edited-new.ts"))
      await writeFile(join(repoDir, "edited-new.ts"), `${editedSource.with(7, "updated").join("\n")}\n`)
      await Bun.$`git add -A`.cwd(repoDir).quiet()
      await Bun.$`git commit -m inventory-head`.cwd(repoDir).quiet()
      await Bun.$`git config diff.renames false`.cwd(repoDir).quiet()

      const diff = await Effect.runPromise(
        resolveDiffRange({ workspace: repoDir, baseRef, headRef: "HEAD" }).pipe(
          Effect.provide(makeRealGitExecLayer()),
          withSilentLogs,
        ),
      )

      expect(new Set(diff.changedFiles)).toEqual(
        new Set([
          "ordinary.txt",
          "added.bin",
          "modified.bin",
          "empty.txt",
          "suppressed.txt",
          "mode-only.sh",
          "pure-new.ts",
          "edited-new.ts",
        ]),
      )
      expect(diff.deletedFiles).toEqual([])
      expect(diff.renamedFromByFile).toEqual(
        new Map([
          ["pure-new.ts", "pure-old.ts"],
          ["edited-new.ts", "edited-old.ts"],
        ]),
      )
      expect(diff.changedLinesByFile.has("added.bin")).toBe(false)
      expect(diff.changedLinesByFile.has("modified.bin")).toBe(false)
      expect(diff.changedLinesByFile.has("empty.txt")).toBe(false)
      expect(diff.changedLinesByFile.has("suppressed.txt")).toBe(false)
      expect(diff.changedLinesByFile.has("mode-only.sh")).toBe(false)
      expect(diff.changedLinesByFile.has("pure-new.ts")).toBe(false)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("inventories text, empty and binary deletions using exact Git path identities", async () => {
    const { repoDir } = await createFixtureRepo()
    const unusualPath = "src/deleted åäö\tfile\nname.txt "
    const paths = [unusualPath, "src/empty.txt", "src/deleted.bin"]

    try {
      await writeFile(join(repoDir, unusualPath), "removed\n")
      await writeFile(join(repoDir, "src/empty.txt"), "")
      await writeFile(join(repoDir, "src/deleted.bin"), new Uint8Array([0, 1, 2]))
      await Bun.$`git add .`.cwd(repoDir).quiet()
      await Bun.$`git commit -m deletion-base`.cwd(repoDir).quiet()
      const baseRef = (await Bun.$`git rev-parse HEAD`.cwd(repoDir).quiet()).text().trim()

      for (const path of paths) {
        await rm(join(repoDir, path))
      }

      await Bun.$`git commit -am deletion-head`.cwd(repoDir).quiet()

      const diff = await Effect.runPromise(
        resolveDiffRange({ workspace: repoDir, baseRef, headRef: "HEAD" }).pipe(
          Effect.provide(makeRealGitExecLayer()),
          withSilentLogs,
        ),
      )

      expect(diff.changedFiles).toEqual([])
      expect(new Set(diff.deletedFiles)).toEqual(new Set(paths))
      expect(diff.renamedFromByFile).toEqual(new Map())
      expect(diff.deletedLinesByFile).toEqual(new Map([[unusualPath, new Set([1])]]))
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("preserves quoted Unicode and whitespace paths in real Git patches and file lists", async () => {
    const { repoDir } = await createFixtureRepo()

    const paths = [
      "src/åäö.ts",
      "docs/my file.md",
      "docs/trailing.md ",
      'src/tab\tquote"line\nname.ts',
      "src/back\\slash.ts",
    ]

    try {
      for (const path of paths) {
        await mkdir(dirname(join(repoDir, path)), { recursive: true })
        await writeFile(join(repoDir, path), "first\nsecond\nthird\n")
      }

      await Bun.$`git add .`.cwd(repoDir).quiet()
      await Bun.$`git commit -m path-base`.cwd(repoDir).quiet()
      const baseRef = (await Bun.$`git rev-parse HEAD`.cwd(repoDir).quiet()).text().trim()

      for (const path of paths) {
        await writeFile(join(repoDir, path), "first\nupdated\nthird\n")
      }

      await Bun.$`git commit -am path-head`.cwd(repoDir).quiet()
      await Bun.$`git config diff.noprefix true`.cwd(repoDir).quiet()

      const diff = await Effect.runPromise(
        resolveDiffRange({ workspace: repoDir, baseRef, headRef: "HEAD" }).pipe(
          Effect.provide(makeRealGitExecLayer()),
          withSilentLogs,
        ),
      )

      // Also cover Git's default octal UTF-8 quoting independently of the adapter's quotePath setting.
      const quotedPatch = (
        await Bun.$`git -c core.quotePath=true diff --src-prefix=a/ --dst-prefix=b/ --no-color ${baseRef} HEAD`
          .cwd(repoDir)
          .quiet()
      ).text()

      expect(new Set(diff.changedFiles)).toEqual(new Set(paths))
      expect(new Set(splitDiffByFile(diff.diffText).map((file) => file.path))).toEqual(new Set(paths))
      expect(new Set(splitDiffByFile(quotedPatch).map((file) => file.path))).toEqual(new Set(paths))

      const expectedLines = new Map(paths.map((path) => [path, new Set([2])] as const))
      expect(diff.changedLinesByFile).toEqual(expectedLines)
      expect(diff.deletedLinesByFile).toEqual(expectedLines)
      expect(extractChangedLinesByFile(quotedPatch)).toEqual(expectedLines)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("counts real hunk content without treating header-like lines or newline markers as headers", async () => {
    const { repoDir } = await createFixtureRepo()

    try {
      await writeFile(join(repoDir, "src/headers.txt"), "first\n-- a/old.ts\n---\nlast\n")
      await writeFile(join(repoDir, "src/no-newline.txt"), "first\n\nthird")
      await Bun.$`git add .`.cwd(repoDir).quiet()
      await Bun.$`git commit -m hunk-base`.cwd(repoDir).quiet()
      const baseRef = (await Bun.$`git rev-parse HEAD`.cwd(repoDir).quiet()).text().trim()

      await writeFile(join(repoDir, "src/headers.txt"), "first\n++ b/evil.ts\n+++\nlast\n")
      await writeFile(join(repoDir, "src/no-newline.txt"), "first\n\nupdated")
      await writeFile(join(repoDir, "src/added.txt"), "++ b/other.ts\nadded\n")
      await Bun.$`git add .`.cwd(repoDir).quiet()
      await Bun.$`git commit -m hunk-head`.cwd(repoDir).quiet()
      await Bun.$`git config diff.suppressBlankEmpty true`.cwd(repoDir).quiet()

      const diff = await Effect.runPromise(
        resolveDiffRange({ workspace: repoDir, baseRef, headRef: "HEAD" }).pipe(
          Effect.provide(makeRealGitExecLayer()),
          withSilentLogs,
        ),
      )

      expect(diff.changedLinesByFile).toEqual(
        new Map([
          ["src/added.txt", new Set([1, 2])],
          ["src/headers.txt", new Set([2, 3])],
          ["src/no-newline.txt", new Set([3])],
        ]),
      )
      expect(diff.deletedLinesByFile).toEqual(
        new Map([
          ["src/headers.txt", new Set([2, 3])],
          ["src/no-newline.txt", new Set([3])],
        ]),
      )
      expect(new Set(splitDiffByFile(diff.diffText).map((file) => file.path))).toEqual(new Set(diff.changedFiles))
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("keeps carriage returns and Unicode separators inside source lines", async () => {
    const { repoDir } = await createFixtureRepo()
    const separators = ["\r", "\u2028", "\u2029"]
    const paths = separators.map((_, index) => `src/separator-${index}.txt`)

    try {
      for (const [index, separator] of separators.entries()) {
        await writeFile(
          join(repoDir, `src/separator-${index}.txt`),
          `first\nprefix${separator}diff --git a/fake b/fake\nmiddle\nfourth\nlast\n`,
        )
      }

      await Bun.$`git add .`.cwd(repoDir).quiet()
      await Bun.$`git commit -m separators-base`.cwd(repoDir).quiet()
      const baseRef = (await Bun.$`git rev-parse HEAD`.cwd(repoDir).quiet()).text().trim()

      for (const [index, separator] of separators.entries()) {
        await writeFile(
          join(repoDir, `src/separator-${index}.txt`),
          `first\nprefix${separator}diff --git a/fake b/fake\n++ b/evil.ts\nfourth\nupdated\n`,
        )
      }

      await Bun.$`git commit -am separators-head`.cwd(repoDir).quiet()

      const diff = await Effect.runPromise(
        resolveDiffRange({ workspace: repoDir, baseRef, headRef: "HEAD" }).pipe(
          Effect.provide(makeRealGitExecLayer()),
          withSilentLogs,
        ),
      )

      expect(diff.changedLinesByFile).toEqual(new Map(paths.map((path) => [path, new Set([3, 5])] as const)))
      expect(new Set(splitDiffByFile(diff.diffText).map((file) => file.path))).toEqual(new Set(paths))
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("keeps edited rename additions on the new path and deletions on the old path", async () => {
    const { repoDir } = await createFixtureRepo()
    const oldPath = "src/rename source.ts"
    const newPath = "src/renamed åäö.ts"
    const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)

    try {
      await writeFile(join(repoDir, oldPath), `${original.join("\n")}\n`)
      await Bun.$`git add .`.cwd(repoDir).quiet()
      await Bun.$`git commit -m rename-base`.cwd(repoDir).quiet()
      const baseRef = (await Bun.$`git rev-parse HEAD`.cwd(repoDir).quiet()).text().trim()

      await rename(join(repoDir, oldPath), join(repoDir, newPath))
      const updated = original.with(7, "changed")
      await writeFile(join(repoDir, newPath), `${updated.join("\n")}\n`)
      await Bun.$`git add -A`.cwd(repoDir).quiet()
      await Bun.$`git commit -m rename-head`.cwd(repoDir).quiet()

      const diff = await Effect.runPromise(
        resolveDiffRange({ workspace: repoDir, baseRef, headRef: "HEAD" }).pipe(
          Effect.provide(makeRealGitExecLayer()),
          withSilentLogs,
        ),
      )

      expect(diff.diffText).toContain("rename from")
      expect(diff.changedFiles).toEqual([newPath])
      expect(diff.deletedFiles).toEqual([])
      expect(diff.renamedFromByFile).toEqual(new Map([[newPath, oldPath]]))
      expect(diff.changedLinesByFile).toEqual(new Map([[newPath, new Set([8])]]))
      expect(diff.deletedLinesByFile).toEqual(new Map([[oldPath, new Set([8])]]))
      expect(splitDiffByFile(diff.diffText).map((file) => file.path)).toEqual([newPath])
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
      expect(diff.deletedFiles).toEqual([])
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
      expect(diff.deletedFiles).toEqual(["src/obsolete.ts"])
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

  test("detects target merges on a first-parent follow-up range", async () => {
    const { repoDir, reviewedSha, headSha, targetSha } = await createTargetMergeFollowUpRepo()

    try {
      const containsTargetMerge = await Effect.runPromise(
        hasTargetMergeCommitInRange({
          workspace: repoDir,
          baseRef: reviewedSha,
          headRef: headSha,
          currentTargetRef: targetSha,
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs),
      )

      expect(containsTargetMerge).toBe(true)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("reports missing target branch metadata with checkout remediation", async () => {
    const { repoDir } = await createFixtureRepo()

    try {
      const failure = await Effect.runPromise(
        resolvePullRequestDiff({
          workspace: repoDir,
          targetBranch: undefined,
        }).pipe(Effect.provide(makeRealGitExecLayer()), withSilentLogs, Effect.flip),
      )

      expect(failure).toBeInstanceOf(MissingGitHistoryError)
      expect(failure).toMatchObject({
        message: expect.stringContaining("target branch metadata"),
        remediation: expect.stringContaining("fetchDepth: 0"),
      })
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test("passes the Git executable and literal arguments to ProcessRunner", async () => {
    const calls: ExecuteCommandInput[] = []
    const args = ["show", "HEAD:src/file with spaces;$(echo literal).ts"]

    const runner = ProcessRunner.of({
      execute: (input) =>
        Effect.sync(() => {
          calls.push(input)

          return { exitCode: 0, stdout: "", stderr: "" }
        }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitExec
        yield* git.execute({
          operation: "Git.test",
          cwd: "/tmp",
          args,
        })
      }).pipe(Effect.provide(GitExecLive.pipe(Layer.provide(Layer.succeed(ProcessRunner, runner))))),
    )

    expect(calls).toEqual([
      {
        operation: "Git.test",
        command: "git",
        cwd: "/tmp",
        args,
        allowNonZeroExit: true,
      },
    ])
  })
})
