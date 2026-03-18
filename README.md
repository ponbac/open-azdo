# open-azdo Monorepo

This repository is a Bun workspaces monorepo managed with Turborepo.

## Workspace Layout

- `apps/open-azdo`
  The publishable CLI package. It owns the command surface, config/env resolution, runtime composition, and package-facing docs.
- `packages/core`
  Shared Bun + Effect foundations and generic capabilities such as logging, process execution, git access, and OpenCode execution.
- `packages/azdo`
  Azure DevOps integration, schemas, context helpers, and the live REST client.
- `packages/workflows`
  Reusable use-case orchestration. Review-specific logic currently lives under `@open-azdo/workflows/review`.

## Common Commands

```bash
bun install
bun run check
bun run build
bun run test
```

Focused iteration is fine during development:

```bash
bun run --cwd apps/open-azdo test
bun run --cwd packages/core typecheck
bun run --cwd packages/workflows test
```

## CLI Package

Package-facing docs and examples live in [`apps/open-azdo/README.md`](./apps/open-azdo/README.md).

## Reference Assets

Reference repositories and Effect API material live under `.reference/`. Refresh them with:

```bash
./scripts/pull-ref-repos.sh
```
