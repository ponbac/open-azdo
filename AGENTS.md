# Open-AZDO Reference Assets

- `.reference/opencode-azdo-extension`
  Role: workflow reference for Azure DevOps pull-request review automation and a negative security reference for v1 boundaries we intentionally do not copy.
- `.reference/tailcode`
  Role: Bun CLI layout, `ox` formatting conventions, and general Bun + Effect code organization reference.
- `.reference/t3code`
  Role: Effect v4 `ServiceMap.Service` construction reference, git workflow/service layering reference, and command/process execution reference.
- `.reference/effect-smol`
  Role: canonical Effect v4 beta source reference for current APIs and idioms.
- `.reference/effect-4.0-beta-article/index.html`
  Role: archived release-context reference for Effect 4.0 beta decisions and terminology.

# Project Snapshot

- `apps/open-azdo`
  Role: publishable CLI app. Owns flags, env resolution, runtime composition, stdout behavior, and package docs.
- `packages/core`
  Role: generic Bun + Effect foundations and reusable capabilities such as logging, process execution, git access, OpenCode execution, and shared path helpers.
- `packages/azdo`
  Role: Azure DevOps integration package for schemas, context helpers, and the live client.
- `packages/workflows`
  Role: reusable orchestration package. Review-specific logic lives under `@open-azdo/workflows/review`.

# Common Commands

- `bun install`
- `bun run check`
- `bun run build`
- `bun run test`
- `bun run --cwd apps/open-azdo test`
- `bun run --cwd packages/core typecheck`
- `bun run --cwd packages/azdo test`
- `bun run --cwd packages/workflows test`

# Task Completion Requirements

- Always run `bun run check` from the repo root before considering a task done.
- If `bun run check` rewrites files, run it again until it finishes cleanly.
- Workspace-local validation is fine during iteration, but final validation is the root `bun run check`.
