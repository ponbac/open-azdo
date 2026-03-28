# Open-AZDO Reference Assets

- `.reference/opencode`
  Role: primary OpenCode upstream reference for CLI, agent, and runtime behavior that `open-azdo` integrates against.
- `.reference/opencode-azdo-extension`
  Role: workflow reference for Azure DevOps pull-request review automation and a negative security reference for v1 boundaries we intentionally do not copy.
- `.reference/tailcode`
  Role: Bun CLI layout, `ox` formatting conventions, and general Bun + Effect code organization reference.
- `.reference/t3code`
  Role: Effect v4 `ServiceMap.Service` construction reference, git workflow/service layering reference, and command/process execution reference.
- `.reference/effect-smol`
  Role: canonical Effect v4 beta source reference for current APIs and idioms.

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
- `bun run typecheck`
- `bun run typecheck:tsc`
- `bun run lint`
- `bun run lint:syntax`
- `bun run --cwd apps/open-azdo test`
- `bun run --cwd packages/core typecheck`
- `bun run --cwd packages/core typecheck:tsc`
- `bun run --cwd packages/azdo test`
- `bun run --cwd packages/workflows test`

# Live Validation

- Opt-in real-environment validation is available through `bun run sandbox:capture` and `bun test ./apps/open-azdo/test/live.integration.test.ts` with `.env.integration.local` loaded.
- The sandbox app can be used to inspect a real captured review locally on `http://127.0.0.1:4317`.
- For this repo, `openai/gpt-5.4-mini` is supported natively on OpenCode `1.3.3`.

# TypeScript Tooling Policy

- Default command lane is TS7 via `@typescript/native-preview` and `tsgo`.
- Explicit fallback lane is regular `typescript`, exposed through `typecheck:tsc`.
- Root `lint` is TS7-backed Oxlint type-aware linting.
- Root `check` relies on TS7-backed linting rather than a separate `tsc` gate.
- Workspace editor TypeScript remains `node_modules/typescript/lib`, so Effect language-service continues using the installed `typescript` package.
- Generated `**/*.js` and `**/*.d.ts` files are intentionally excluded from linting.
- `ts5to6` and related migration helpers were researched but are not needed for the current `tsconfig` shape.

# Task Completion Requirements

- Always run `bun run check` from the repo root before considering a task done.
- If `bun run check` rewrites files, run it again until it finishes cleanly.
- Make sure that only absolutely necessary test cases are written, cover the critical paths only.
- For changed code, add doc comments to non-trivial, non-self-explanatory shared functions, explaining what they do and how they work.
- For changed code, add inline comments inside functions for non-obvious code paths, data-shaping, ranking/merging logic, or other behavior that would otherwise require careful reconstruction by the reader.
- Workspace-local validation is fine during iteration, but final validation is the root `bun run check`.
