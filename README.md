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
bun run publish:dry
bun run publish:npm
```

Focused iteration is fine during development:

```bash
bun run --cwd apps/open-azdo test
bun run --cwd packages/core typecheck
bun run --cwd packages/workflows test
```

To publish the CLI package from the repo root, use Bun's built-in publish command with the app workspace as the working directory:

```bash
bun publish --cwd apps/open-azdo
```

If Bun does not pick up your `~/.npmrc` login for publish auth, export `NPM_CONFIG_TOKEN` first.

For a guarded flow that mirrors the pre-monorepo setup, use:

```bash
bun run publish:dry
bun run publish:npm
```

`bun publish` itself is a Bun CLI command, not a package script alias, so it cannot be redirected to a root `package.json` script.

## CLI Package

Package-facing docs and examples live in [`apps/open-azdo/README.md`](./apps/open-azdo/README.md).

## Reference Assets

Reference repositories and Effect API material live under `.reference/`. Refresh them with:

```bash
./scripts/pull-ref-repos.sh
```
