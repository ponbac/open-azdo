# Security

## Scope

`open-azdo` is intended for review and verification in trusted repositories. The CLI reads the checked-out workspace and writes Azure DevOps PR threads. Its generated OpenCode agent permits native read tools, shell execution, and result submission. It is instructed to leave tracked source unchanged, but shell access is not a read-only boundary or operating-system isolation.

## Threat Model

Inputs are treated as untrusted:

- pull-request title and description
- pull-request thread comments
- repository contents
- generated diffs and file excerpts
- model output

Primary goals:

- minimize accidental secret exposure in stdout, stderr, and structured logs
- avoid broad repository or network mutation paths
- keep Azure DevOps permissions limited to repository read plus PR thread read/write

## Checkout-First Design

The CLI uses the Azure Pipeline checkout workspace instead of PAT-based clone URLs. This avoids embedding tokens in clone commands or remote URLs and keeps auth scoped to the pipeline-provided `System.AccessToken`.

For correct diff resolution, use:

- `checkout: self`
- `fetchDepth: 0`
- `persistCredentials: false`

If required history is missing, `open-azdo` fails with a remediation message instead of guessing.

## Secret Handling

- Azure DevOps auth comes from `SYSTEM_ACCESSTOKEN`
- secrets are wrapped with Effect `Redacted`
- log rendering sanitizes token-like fields before output
- authenticated git URLs are never constructed
- `SYSTEM_ACCESSTOKEN` and `OPEN_AZDO_LIVE_ACCESS_TOKEN`, including case variants, are removed from the model server environment
- provider credential variables remain available to OpenCode so the selected model can authenticate

## OpenCode Containment

Each review run starts a short-lived, password-protected OpenCode server bound to `127.0.0.1` on a dynamically chosen port and shuts it down on exit. The generated `azdo-review` agent is deny-by-default:

- read, glob, grep, shell, and skill tools allowed
- native edit and write tools denied; shell commands can still write files and run repository code
- web fetch and web search denied
- subagents denied
- external-directory access allowed for dependency inspection, scratch verification, and saved tool output

The reviewer may run Bash/Python scripts and targeted tests to verify findings. Repository `opencode.json` and `.opencode` content, including plugins, is loaded as usual. Use repositories whose contributors you trust and a CI workspace appropriate for executing their code; command permissions do not provide strong containment.

The server runs under the same operating-system identity as the CLI. Environment filtering does not prevent same-user access to the parent process, `/proc` where permitted, credential files, or other accessible filesystem data. The tool permissions do not provide a general guarantee against secret exposure or host mutation. Strong containment requires separate operating-system isolation, such as a separate UID or a container; `open-azdo` does not provision it.

OpenCode is prompted through `@opencode/client`. V2 has no native structured output, so a run-scoped plugin registers a JSON-schema submission tool and the workflow reads the validated tool input. If no valid submission exists, the workflow attempts JSON repair on the text reply. An undecodable review fails without advancing the reviewed commit, preserving eligibility for a rerun. Only the optional summary pass can fall back to deterministic rendering, using the findings from an already validated review.

OpenCode handles compaction normally; compaction alone does not invalidate a review. A scoped task file and an additive instruction let the agent recover its original task and Git refs, and patches remain available through per-file Git inspection. Only the file copy is line-wrapped so native reads can recover long context through pagination. Prompt metadata may omit optional range/hunk detail with an explicit flag; paths and eligible reconciliation candidates remain complete. Git diff/status output is bounded at 64 MiB per stream and two minutes, while other commands retain their defaults. Model/context limits and workflow timeouts still apply. A typed optional-summary failure can use deterministic rendering of the completed review.

This short-lived session finishes at its first completed turn and cannot resume background verification afterward. The runtime therefore converts shell requests with `background: true` to foreground execution, and the prompt supplies the configured overall time budget. This does not prevent scripts or targeted tests; their results must arrive before review submission.

## Azure DevOps Mutations

The only intended write surface is PR thread management:

- one managed summary thread
- one managed inline thread per active finding, with continuity selected by the reviewer model through the prior thread id and identical already-published content reused during retries
- managed finding threads closed only when the reviewer model explicitly resolves an in-scope prior thread id

Managed state is accepted only from nondeleted comments authored by the identity authenticated by the current Azure token. Display names and marker text alone do not establish ownership. Changing the token's identity can therefore cause a fresh review instead of adopting another account's checkpoint.

Operational failures always use a separate bot-owned failure marker with no reviewed commit. Retries update that notice without replacing the last completed summary. Successful reviews or same-commit skips resolve an active failure notice; skips do not rewrite the summary comment. Failures point to pipeline logs rather than publishing stack traces.

Findings and thread-status changes are published before the summary's reviewed-commit checkpoint. A partial publication failure is surfaced as an operational failure, retains the previous checkpoint, and leaves the missing work eligible for a rerun. Identical findings already posted by that identity can be reused on retry.

## Reporting

If you find a security issue, avoid opening a public issue with exploit details. Share a minimal reproduction and impact summary privately through the repository’s preferred disclosure channel.
