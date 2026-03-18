export { GitExec, type ExecuteGitInput, type ExecuteGitResult, type GitExecShape } from "./git/Services/GitExec"
export {
  buildTargetRefCandidates,
  compressChangedLines,
  extractChangedLinesByFile,
  extractHunkHeaders,
  isAncestor,
  resolveDiffRange,
  resolvePullRequestDiff,
  resolveReviewedSourceCommit,
  resolveTargetRef,
  splitDiffByFile,
  type DiffFile,
  type IsAncestorInput,
  type LineRange,
  type PullRequestDiff,
  type ResolveDiffRangeInput,
  type ResolvePullRequestDiffInput,
  type ResolveReviewedSourceCommitInput,
} from "./git/PullRequestDiff"
export { GitExecLive } from "./git/Layers/GitExec"
