# open-azdo

`open-azdo` is a Bun CLI for Azure DevOps pull-request review runs in Azure Pipelines. It reviews the checked-out workspace with OpenCode, posts one managed summary thread plus managed inline finding threads, and stays comment-only in v1.

## Why This Exists

This package is the published-package path for Azure DevOps PR review automation. Unlike the Marketplace extension reference, v1 intentionally does not:

- edit the repository
- commit or push changes
- accept pull-request comments as commands to run automation
- rely on a persistent or shared OpenCode server
- rely on tokenized clone URLs

The CLI consumes the Azure Pipeline checkout workspace directly and uses the built-in `System.AccessToken` for the minimal Azure DevOps REST surface.
The generated reviewer can use OpenCode's native read/search tools, repository skills, and shell commands, including Bash, Python, and targeted test runs, to verify findings. It can inspect dependencies outside the workspace, use scratch directories, and reread full saved tool output. Azure job tokens are omitted from the model server environment while provider credentials remain available. Shell access can execute arbitrary repository code; use trusted private repositories and an appropriate CI workspace. See [SECURITY.md](./SECURITY.md).
Each review run starts a short-lived localhost OpenCode server, prompts it through `@opencode/client`, collects the JSON-schema result through a run-scoped submission tool, and tears it down before exit. If the model returns malformed JSON, `open-azdo` attempts repair. If no valid review result can be decoded, the run fails without advancing the reviewed commit, so a rerun reviews those changes again. The optional summary pass can fall back to deterministic rendering of an already completed review.

The reviewer receives a manifest with exact Git refs, every changed/deleted path, rename origins, and optional changed-line detail, then inspects patches through `git diff`. It may trace callers, tests, configuration, and downstream consumers anywhere needed, while reporting problems caused or exposed by the supplied range. Large manifests omit optional detail rather than paths and explicitly set `diffMetadataTruncated`; full line maps remain available to the CLI. All eligible prior findings remain available for reconciliation without a separate character cutoff.

OpenCode manages context compaction normally. The original task remains in a run-scoped file referenced by additive instructions. Its file copy is line-wrapped for native reads and can be read in pages after compaction; the actual model prompt stays compact. Verification runs in the foreground so this short-lived session receives results before completing. The prompt includes the configured overall deadline, and the runtime normalizes background shell requests to foreground execution.

Only comments authored by the current token's authenticated identity supply managed review state. Findings and status updates finish before publishing the reviewed-commit checkpoint. Operational failures use a separate notice and preserve the completed summary; same-commit skips leave that summary untouched and close an active failure notice. Findings placed in the summary retain their full evidence and suggestions even if the optional summary pass falls back.

Git patch and file-status collection allow 64 MiB per output stream and two minutes; short Git/process commands retain their smaller defaults. Prompt navigation detail is limited to 100 ranges/hunk headers per file and a 250,000-character detail target. Path identities are never dropped, even when they alone exceed that target. Model/context limits and the configured review timeout still apply.

Azure DevOps documents a [150,000-character limit per PR comment](https://github.com/microsoft/azure-devops-python-api/blob/dev/azure-devops/azure/devops/v7_1/git/git_client_base.py#L2425-L2428). If publication is rejected, the run fails without advancing its checkpoint; findings are not silently shortened to fit.

## Install And Run

Use Bun 1.3.10 or newer.

```bash
bun x open-azdo review --model "openai/gpt-5.4"
```

Required inputs:

- `--model` or `OPEN_AZDO_MODEL`
- `SYSTEM_ACCESSTOKEN`

Common Azure Pipeline defaults:

- `OPEN_AZDO_WORKSPACE` or `BUILD_SOURCESDIRECTORY`
- `OPEN_AZDO_COLLECTION_URL` or `SYSTEM_COLLECTIONURI`
- `OPEN_AZDO_PROJECT` or `SYSTEM_TEAMPROJECT`
- `OPEN_AZDO_REPOSITORY_ID` or `BUILD_REPOSITORY_ID`
- `OPEN_AZDO_PULL_REQUEST_ID` or `SYSTEM_PULLREQUEST_PULLREQUESTID`

Optional flags:

- `--opencode-variant <name>` provider-specific variant or reasoning level, for example `minimal`, `low`, `medium`, `high`, or `xhigh`
- `--opencode-timeout <duration>` default `10 minutes`, for example `5 minutes` or `1 hour`
- `--workspace <path>`
- `--organization <name>`
- `--project <name>`
- `--repository-id <id>`
- `--pull-request-id <id>`
- `--collection-url <url>`
- `--agent <name>` default `azdo-review`
- `--prompt-file <path>`
- `--dry-run`
- `--json`

## Output And Logging

Operational logs are pretty, colorized, and written to `stderr` by default so humans can follow the run in local terminals and CI job logs.
The final command result stays on `stdout`.

Use `--json` when you want fully machine-readable output:

- command results stay on `stdout` as JSON
- operational logs stay on `stderr` as JSON
- `review` and `sandbox capture` both follow the same contract

During OpenCode execution, `open-azdo` now emits live progress milestones such as session start, retries, tool start and failure, and session errors. Raw assistant text deltas and full tool outputs are intentionally omitted from default logs to keep them readable.

## Sandbox Capture

Use the live capture command when you want to validate changes against a real Azure DevOps pull request without mutating PR threads:

```bash
bun run ./bin/open-azdo.ts sandbox capture --model "openai/gpt-5.4"
```

The command is intentionally opt-in and uses a separate env namespace:

- `OPEN_AZDO_LIVE_MODEL`
- `OPEN_AZDO_LIVE_OPENCODE_VARIANT`
- `OPEN_AZDO_LIVE_OPENCODE_TIMEOUT`
- `OPEN_AZDO_LIVE_WORKSPACE`
- `OPEN_AZDO_LIVE_COLLECTION_URL`
- `OPEN_AZDO_LIVE_ORGANIZATION`
- `OPEN_AZDO_LIVE_PROJECT`
- `OPEN_AZDO_LIVE_REPOSITORY_ID`
- `OPEN_AZDO_LIVE_PULL_REQUEST_ID`
- `OPEN_AZDO_LIVE_ACCESS_TOKEN`

Provider API keys remain provider-native, for example `OPENAI_API_KEY`.

Behavior:

- if `OPEN_AZDO_LIVE_WORKSPACE` or `--workspace` is set, `open-azdo` validates that checkout and does not mutate it
- otherwise it creates a temporary checkout, fetches the PR source and target refs, runs the review, and deletes the temp checkout on exit
- Azure DevOps stays read-only for this command
- the same short-lived localhost OpenCode server behavior used by `review` is reused here

Default output path:

```text
.captures/<org>-<project>-pr-<id>.json
```

From the monorepo root you can use:

```bash
bun run sandbox:capture
```

Start with [`.env.integration.example`](../../.env.integration.example) and write your local secrets to `.env.integration.local`.

Exit behavior:

- successful review runs return `0`, even when findings are posted
- operational failures return non-zero
- logs always use `stderr`; results always use `stdout`

## Azure Pipelines

The canonical example is in [examples/azure-pipelines.review.yml](./examples/azure-pipelines.review.yml).
For first-time rollout or debugging, use [examples/azure-pipelines.review.debug.yml](./examples/azure-pipelines.review.debug.yml).
For pnpm-managed repositories that want dependency install, `.NET` provisioning, and restore, use [examples/azure-pipelines.review.pnpm.yml](./examples/azure-pipelines.review.pnpm.yml).

Key requirements:

- use `checkout: self`
- set `fetchDepth: 0`
- keep `persistCredentials: false`
- enable `Allow scripts to access the OAuth token`
- grant repository read and pull request thread read/write permissions

Attach the pipeline as a branch build-validation policy. Findings are posted as PR comments by default and do not fail the build.
`open-azdo` does not install language-specific prerequisites itself. The pnpm example provisions `.NET` plus `dotnet restore` for C# projects. OpenCode V2 does not run language servers, so reviews rely on the read, search, and git tools.
For nested JS or TS packages, install dependencies in the package directory that owns the lockfile before running `open-azdo`. `open-azdo` keeps the review workspace at the checkout root.

```yaml
trigger: none

pool:
  vmImage: ubuntu-latest

variables:
  OpenCodeModel: openai/gpt-5.4-mini
  OpenCodeThinking: high

steps:
  - checkout: self
    clean: true
    fetchDepth: 0
    persistCredentials: false

  - bash: |
      set -euo pipefail
      curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip -o bun.zip
      unzip -q bun.zip
      export PATH="$PWD/bun-linux-x64:$PATH"

      curl -fsSL https://github.com/anomalyco/opencode/releases/download/v2.2.3/opencode-linux-x64.tar.gz -o opencode.tar.gz
      mkdir -p opencode-bin
      tar -xzf opencode.tar.gz -C opencode-bin
      export PATH="$PWD/opencode-bin:$PATH"

      bun x open-azdo review --model "$(OpenCodeModel)" --opencode-variant "$(OpenCodeThinking)"
    displayName: Review Pull Request
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
      OPENAI_API_KEY: $(OpenAIApiKey)
      OPEN_AZDO_OPENCODE_TIMEOUT: "10 minutes"
```

## Development

From the monorepo root:

```bash
bun install
bun run check
bun run build
```

For local sandbox validation:

```bash
bun run sandbox:capture
bun run sandbox:dev
```

The sandbox app runs on `http://127.0.0.1:4317`, not port `3000`. The expected UI smoke path is manual validation with the `playwriter` skill.
