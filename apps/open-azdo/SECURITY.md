# Security

## Scope

`open-azdo` is review-only in v1. It reads the checked-out workspace, calls OpenCode in read-only mode, and writes Azure DevOps PR threads. It does not edit files, commit, push, or invoke arbitrary helper scripts for mutations.

## Threat Model

Inputs are treated as untrusted:

- pull-request title and description
- repository contents
- generated diffs and file excerpts
- model output

Primary goals:

- never leak secrets to stdout, stderr, or structured logs
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

## OpenCode Containment

Each review run creates a temporary OpenCode config directory and removes it on exit. The generated `azdo-review` agent is read-only:

- read/search/listing tools allowed
- edit and write denied
- web fetch and web search denied
- bash denied by default, with a narrow allowlist for read-style commands

The CLI uses `opencode run --format json` directly. There is no long-lived server and no fixed local port to secure.

## Azure DevOps Mutations

The only intended write surface is PR thread management:

- one managed summary thread
- one managed inline thread per finding fingerprint
- stale managed finding threads marked `fixed`

Comment-post failures are surfaced as operational failures and do not get swallowed.

## Reporting

If you find a security issue, avoid opening a public issue with exploit details. Share a minimal reproduction and impact summary privately through the repository’s preferred disclosure channel.
