import { Effect } from "effect"
import { MissingGitHistoryError } from "../errors"
import { GitExec } from "./Services/GitExec"
export type PullRequestDiff = {
  readonly baseRef: string
  readonly headRef: string
  readonly diffText: string
  readonly changedFiles: string[]
  readonly changedLinesByFile: Map<string, Set<number>>
  readonly deletedLinesByFile: Map<string, Set<number>>
}
export type DiffFile = {
  readonly path: string
  readonly patch: string
}
export type LineRange = {
  readonly start: number
  readonly end: number
}
export type ResolvePullRequestDiffInput = {
  readonly workspace: string
  readonly targetBranch: string | undefined
}
export type ResolveDiffRangeInput = {
  readonly workspace: string
  readonly baseRef: string
  readonly headRef: string
}
export type ResolveReviewedSourceCommitInput = {
  readonly workspace: string
  readonly sourceCommitId: string | undefined
}
export type IsAncestorInput = {
  readonly workspace: string
  readonly ancestorRef: string
  readonly headRef: string
}
export declare const splitDiffByFile: (diffText: string) => DiffFile[]
export declare const compressChangedLines: (changedLines: ReadonlySet<number>) => LineRange[]
export declare const extractHunkHeaders: (patch: string) => string[]
export declare const extractChangedLinesByFile: (diffText: string) => Map<string, Set<number>>
export declare const buildTargetRefCandidates: (targetBranch: string) => string[]
export declare const resolveReviewedSourceCommit: ({
  workspace,
  sourceCommitId,
}: ResolveReviewedSourceCommitInput) => Effect.Effect<
  string,
  import("../errors").GitCommandError | MissingGitHistoryError,
  GitExec
>
export declare const isAncestor: ({
  workspace,
  ancestorRef,
  headRef,
}: IsAncestorInput) => Effect.Effect<boolean, import("../errors").GitCommandError | MissingGitHistoryError, GitExec>
export declare const resolveDiffRange: ({ workspace, baseRef, headRef }: ResolveDiffRangeInput) => Effect.Effect<
  {
    baseRef: string
    headRef: string
    diffText: string
    changedFiles: string[]
    changedLinesByFile: Map<string, Set<number>>
    deletedLinesByFile: Map<string, Set<number>>
  },
  import("../errors").GitCommandError,
  GitExec
>
export declare const resolveTargetRef: ({
  workspace,
  targetBranch,
}: ResolvePullRequestDiffInput) => Effect.Effect<
  string,
  import("../errors").GitCommandError | MissingGitHistoryError,
  GitExec
>
export declare const resolvePullRequestDiff: (input: ResolvePullRequestDiffInput) => Effect.Effect<
  {
    baseRef: string
    headRef: string
    diffText: string
    changedFiles: string[]
    changedLinesByFile: Map<string, Set<number>>
    deletedLinesByFile: Map<string, Set<number>>
  },
  import("../errors").GitCommandError | MissingGitHistoryError,
  GitExec
>
