import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Redacted } from "effect"

import { type PullRequestMetadata } from "@open-azdo/azdo/client"
import { MissingGitHistoryError } from "@open-azdo/core/errors"
import { GitExec, resolvePullRequestDiff, resolveReviewedSourceCommit } from "@open-azdo/core/git"

/** A validated caller-owned checkout or a temporary checkout owned by the current scope. */
export type PreparedSandboxWorkspace = {
  readonly path: string
  readonly mode: "provided" | "temporary"
}

const requireMetadataField = (value: string | undefined, label: string) =>
  value && value.trim().length > 0
    ? Effect.succeed(value)
    : Effect.fail(
        new MissingGitHistoryError({
          message: `Sandbox capture requires pull request ${label}.`,
          remediation: `Ensure Azure DevOps returns ${label} for the target pull request.`,
        }),
      )

const writeAskPassScript = (directory: string) =>
  Effect.tryPromise({
    try: async () => {
      const scriptPath = join(directory, "git-askpass.sh")
      await writeFile(
        scriptPath,
        `#!/usr/bin/env sh
case "$1" in
  Username*) printf '%s\\n' "open-azdo" ;;
  Password*) printf '%s\\n' "$OPEN_AZDO_LIVE_ACCESS_TOKEN" ;;
  *) printf '\\n' ;;
esac
`,
        "utf8",
      )
      await chmod(scriptPath, 0o700)

      return scriptPath
    },
    catch: (error) =>
      new MissingGitHistoryError({
        message: "Failed to prepare sandbox git authentication helper.",
        remediation: String(error),
      }),
  })

const targetRemoteRef = (targetRefName: string) => `refs/remotes/origin/${targetRefName.replace(/^refs\/heads\//, "")}`

const runGit = (cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const git = yield* GitExec

    return yield* git.execute({
      operation: `SandboxWorkspace.${args[0] ?? "git"}`,
      cwd,
      args,
      env,
    })
  })

const fetchSourceRevision = ({
  directory,
  sourceRefName,
  sourceCommitId,
  env,
}: {
  readonly directory: string
  readonly sourceRefName: string
  readonly sourceCommitId: string | undefined
  readonly env: NodeJS.ProcessEnv
}) =>
  runGit(directory, ["fetch", "--no-tags", "origin", sourceRefName], env).pipe(
    Effect.catchTag("GitCommandError", (error) =>
      sourceCommitId !== undefined && error.detail.includes("couldn't find remote ref")
        ? runGit(directory, ["fetch", "--no-tags", "origin", sourceCommitId], env)
        : Effect.fail(error),
    ),
  )

const validateWorkspace = ({
  workspace,
  targetBranch,
  sourceCommitId,
}: {
  readonly workspace: string
  readonly targetBranch: string
  readonly sourceCommitId: string | undefined
}) =>
  Effect.all([
    resolvePullRequestDiff({
      workspace,
      targetBranch,
    }),
    resolveReviewedSourceCommit({
      workspace,
      sourceCommitId,
    }),
  ]).pipe(Effect.as(workspace))

/** Fetch both PR revisions into a scoped checkout using an environment-backed askpass helper. */
const createTemporaryWorkspace = ({
  metadata,
  token,
}: {
  readonly metadata: PullRequestMetadata
  readonly token: Redacted.Redacted<string>
}) =>
  Effect.gen(function* () {
    const remoteUrl = yield* requireMetadataField(metadata.repository?.remoteUrl, "repository.remoteUrl")
    const sourceRefName = yield* requireMetadataField(metadata.sourceRefName, "sourceRefName")
    const targetRefName = yield* requireMetadataField(metadata.targetRefName, "targetRefName")

    // Own the directory before setup starts so failures and interruption also remove it.
    const directory = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "open-azdo-sandbox-")),
        catch: (error) =>
          new MissingGitHistoryError({
            message: "Failed to create temporary sandbox checkout.",
            remediation: String(error),
          }),
      }),
      (path) =>
        Effect.tryPromise({
          try: () => rm(path, { recursive: true, force: true }),
          catch: (error) => new Error(String(error)),
        }).pipe(Effect.ignore),
    )

    const askPass = yield* writeAskPassScript(directory)

    const env = {
      GIT_ASKPASS: askPass,
      GIT_TERMINAL_PROMPT: "0",
      OPEN_AZDO_LIVE_ACCESS_TOKEN: Redacted.value(token),
    } satisfies NodeJS.ProcessEnv

    yield* runGit(directory, ["init", "--initial-branch=main"], env)
    yield* runGit(directory, ["remote", "add", "origin", remoteUrl], env)
    yield* runGit(
      directory,
      ["fetch", "--no-tags", "origin", `${targetRefName}:${targetRemoteRef(targetRefName)}`],
      env,
    )
    yield* fetchSourceRevision({
      directory,
      sourceRefName,
      sourceCommitId: metadata.sourceCommitId,
      env,
    })
    yield* runGit(directory, ["checkout", "--detach", metadata.sourceCommitId ?? "FETCH_HEAD"], env)

    return directory
  })

/**
 * Validate a supplied checkout without mutating it, or prepare a temporary checkout
 * whose directory is removed when the calling scope exits, including during setup.
 */
export const prepareSandboxWorkspace = Effect.fn("SandboxWorkspace.prepare")(function* ({
  requestedWorkspace,
  metadata,
  token,
}: {
  readonly requestedWorkspace: string | undefined
  readonly metadata: PullRequestMetadata
  readonly token: Redacted.Redacted<string>
}) {
  if (requestedWorkspace) {
    const targetBranch = yield* requireMetadataField(metadata.targetRefName, "targetRefName")

    const path = yield* validateWorkspace({
      workspace: requestedWorkspace,
      targetBranch,
      sourceCommitId: metadata.sourceCommitId,
    }).pipe(
      Effect.catchTag("MissingGitHistoryError", (error) =>
        Effect.fail(
          new MissingGitHistoryError({
            message: error.message,
            remediation: `${error.remediation} Unset OPEN_AZDO_LIVE_WORKSPACE to allow a temporary checkout instead.`,
          }),
        ),
      ),
    )

    return { path, mode: "provided" as const }
  }

  const path = yield* createTemporaryWorkspace({ metadata, token })

  return { path, mode: "temporary" as const }
})
