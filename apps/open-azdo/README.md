# open-azdo

`open-azdo` is a Bun CLI for Azure DevOps pull-request review runs in Azure Pipelines. It reviews the checked-out workspace with OpenCode, posts one managed summary thread plus managed inline finding threads, and stays comment-only in v1.

## Why This Exists

This package is the published-package path for secure PR review automation. Unlike the Marketplace extension reference, v1 intentionally does not:

- edit the repository
- commit or push changes
- expose command-triggered execution modes
- run a long-lived OpenCode server
- rely on tokenized clone URLs

The CLI consumes the Azure Pipeline checkout workspace directly and uses the built-in `System.AccessToken` for the minimal Azure DevOps REST surface.

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

Exit behavior:

- successful review runs return `0`, even when findings are posted
- operational failures return non-zero

## Azure Pipelines

The canonical example is in [examples/azure-pipelines.review.yml](./examples/azure-pipelines.review.yml).
For first-time rollout or debugging, use [examples/azure-pipelines.review.debug.yml](./examples/azure-pipelines.review.debug.yml).

Key requirements:

- use `checkout: self`
- set `fetchDepth: 0`
- keep `persistCredentials: false`
- enable `Allow scripts to access the OAuth token`
- grant repository read and pull request thread read/write permissions

Attach the pipeline as a branch build-validation policy. Findings are posted as PR comments by default and do not fail the build.

```yaml
trigger: none

pool:
  vmImage: ubuntu-latest

variables:
  OpenCodeModel: openai/gpt-5.4
  OpenCodeThinking: high

steps:
  - checkout: self
    clean: true
    fetchDepth: 0
    persistCredentials: false

  - bash: |
      set -euo pipefail
      curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.10/bun-linux-x64.zip -o bun.zip
      unzip -q bun.zip
      export PATH="$PWD/bun-linux-x64:$PATH"

      curl -fsSL https://github.com/sst/opencode/releases/download/v1.2.27/opencode-linux-x64.tar.gz -o opencode.tar.gz
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
