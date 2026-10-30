# Security

## Scope

`open-azdo` is intended for review-only use in v1. The CLI reads the checked-out workspace and writes Azure DevOps PR threads. Its generated OpenCode agent permits native read tools and result submission, and denies shell execution, edits, and writes. These permissions are application guardrails, not operating-system isolation.

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

- read, glob, and grep tools allowed
- edit and write denied
- web fetch and web search denied
- subagents, skills, and directories outside the workspace denied for OpenCode's native tools
- all shell commands denied, including git commands; arguments such as `git diff --output` can write files

Native read, glob, and grep tools cover workspace inspection without a shell allowlist. Repository `opencode.json` and `.opencode` content, including plugins, is loaded as usual, so run `open-azdo` only on repositories whose contributors you trust.

The server runs under the same operating-system identity as the CLI. Environment filtering does not prevent same-user access to the parent process, `/proc` where permitted, credential files, or other accessible filesystem data. The tool permissions do not provide a general guarantee against secret exposure or host mutation. Strong containment requires separate operating-system isolation, such as a separate UID or a container; `open-azdo` does not provision it.

OpenCode is prompted through `@opencode/client`. V2 has no native structured output, so a run-scoped plugin registers a JSON-schema submission tool and the workflow reads the validated tool input. If no valid submission exists, the workflow attempts JSON repair on the text reply. An undecodable review fails without advancing the reviewed commit, preserving eligibility for a rerun. Only the optional summary pass can fall back to deterministic rendering, using the findings from an already validated review.

The scoped patch is limited to 64 KiB and the complete review prompt to 128 KiB of UTF-8 input. Neither is truncated to fit. Any OpenCode compaction record, or inability to verify compaction history, fails the pass rather than accepting a result after the original evidence may have been discarded. A failed main review retains the previous checkpoint; a failed optional summary can still use deterministic rendering of the completed review.

## Azure DevOps Mutations

The only intended write surface is PR thread management:

- one managed summary thread
- one managed inline thread per active finding, with continuity selected by the reviewer model through the prior thread id and identical already-published content reused during retries
- managed finding threads closed only when the reviewer model explicitly resolves an in-scope prior thread id

Managed state is accepted only from nondeleted comments authored by the identity authenticated by the current Azure token. Display names and marker text alone do not establish ownership. Changing the token's identity can therefore cause a fresh review instead of adopting another account's checkpoint.

A failed first review uses a separate bot-owned failure marker with no reviewed commit. Retries update that notice, and a successful review reuses it for the managed summary. Expected input-limit failures show the remediation message; other operational failures point to pipeline logs rather than publishing stack traces.

Findings and thread-status changes are published before the summary's reviewed-commit checkpoint. A partial publication failure is surfaced as an operational failure, retains the previous checkpoint, and leaves the missing work eligible for a rerun. Identical findings already posted by that identity can be reused on retry.

## Reporting

If you find a security issue, avoid opening a public issue with exploit details. Share a minimal reproduction and impact summary privately through the repository’s preferred disclosure channel.
