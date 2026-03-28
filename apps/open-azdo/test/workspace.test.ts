import { existsSync } from "node:fs"

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"

import { BaseRuntimeLayer } from "@open-azdo/core/base-runtime"
import { GitCommandError } from "@open-azdo/core/errors"
import { GitExec, GitExecLive } from "@open-azdo/core/git"
import { ProcessRunnerLive } from "@open-azdo/core/process-runner"

import { prepareSandboxWorkspace } from "../src/live/Workspace"
import { createFixtureRepo } from "./helpers"

const makeGitLayer = () => {
  const processRunnerLayer = ProcessRunnerLive.pipe(Layer.provide(BaseRuntimeLayer))
  return GitExecLive.pipe(Layer.provide(processRunnerLayer))
}

describe("sandbox workspace", () => {
  test("uses the provided workspace when it already has the required git history", async () => {
    const fixture = await createFixtureRepo()

    const prepared = await Effect.scoped(
      prepareSandboxWorkspace({
        requestedWorkspace: fixture.repoDir,
        metadata: {
          title: "Feature PR",
          description: "Adds a new export",
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          sourceCommitId: fixture.featureSha,
          repository: {
            remoteUrl: fixture.repoDir,
          },
          workItemRefs: [],
        },
        token: Redacted.make("system-token"),
      }),
    ).pipe(Effect.provide(makeGitLayer()), Effect.runPromise)

    expect(prepared.mode).toBe("provided")
    expect(prepared.path).toBe(fixture.repoDir)
  })

  test("creates and cleans up a temporary workspace when no checkout is provided", async () => {
    const fixture = await createFixtureRepo()
    let temporaryPath = ""

    const prepared = await Effect.scoped(
      prepareSandboxWorkspace({
        requestedWorkspace: undefined,
        metadata: {
          title: "Feature PR",
          description: "Adds a new export",
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          sourceCommitId: fixture.featureSha,
          repository: {
            remoteUrl: fixture.repoDir,
          },
          workItemRefs: [],
        },
        token: Redacted.make("system-token"),
      }).pipe(
        Effect.tap((workspace) =>
          Effect.sync(() => {
            temporaryPath = workspace.path
          }),
        ),
      ),
    ).pipe(Effect.provide(makeGitLayer()), Effect.runPromise)

    expect(prepared.mode).toBe("temporary")
    expect(temporaryPath.length).toBeGreaterThan(0)
    expect(existsSync(temporaryPath)).toBe(false)
  })

  test("falls back to the source commit when the source branch ref is no longer available", async () => {
    const calls: Array<ReadonlyArray<string>> = []

    const gitLayer = Layer.succeed(GitExec, {
      execute: (input) => {
        calls.push(input.args)

        if (input.args[0] === "fetch" && input.args.at(-1) === "refs/heads/feature") {
          return Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: `git ${input.args.join(" ")}`,
              cwd: input.cwd,
              detail: "git fetch failed: fatal: couldn't find remote ref refs/heads/feature",
            }),
          )
        }

        return Effect.succeed({
          exitCode: 0,
          stdout: "",
          stderr: "",
        })
      },
    })

    const prepared = await Effect.scoped(
      prepareSandboxWorkspace({
        requestedWorkspace: undefined,
        metadata: {
          title: "Completed PR",
          description: "Source branch was deleted after merge",
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          sourceCommitId: "abc123",
          repository: {
            remoteUrl: "https://example.invalid/repo.git",
          },
          workItemRefs: [],
        },
        token: Redacted.make("system-token"),
      }),
    ).pipe(Effect.provide(gitLayer), Effect.runPromise)

    expect(prepared.mode).toBe("temporary")
    expect(calls).toEqual([
      ["init", "--initial-branch=main"],
      ["remote", "add", "origin", "https://example.invalid/repo.git"],
      ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"],
      ["fetch", "--no-tags", "origin", "refs/heads/feature"],
      ["fetch", "--no-tags", "origin", "abc123"],
      ["checkout", "--detach", "abc123"],
    ])
  })
})
