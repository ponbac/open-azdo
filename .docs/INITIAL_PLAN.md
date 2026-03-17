# Open-AZDO Secure Review CLI

## Summary
- Build `open-azdo` as a published Bun CLI, not a Marketplace extension.
- V1 is review-only. No repo edits, commits, pushes, or comment-triggered command mode.
- The CLI uses the Azure Pipeline checkout workspace, not PAT-based clone flows.
- OpenCode is invoked with `opencode run --format json`; no local SDK server and no fixed port.
- Bun built-ins are the default for `fetch`, process spawning, tempdirs, file IO, and hashing. Effect v4 beta is used for config loading, schemas, redacted secrets, structured errors, retries, scoped cleanup, and runtime composition.

## Bootstrap / Reference Assets
- Add `.reference/opencode-azdo-extension` from `https://github.com/trojanmartin/opencode-azdo-extension.git` via shallow clone.
- Add `.reference/tailcode` from `https://github.com/kitlangton/tailcode.git` via shallow clone.
- Add `.reference/effect-smol` from `https://github.com/Effect-TS/effect-smol.git` via shallow clone.
- Add `.reference/effect-4.0-beta-article/index.html` as an archived snapshot of `https://effect.website/blog/releases/effect/40-beta/`.
- Add `scripts/pull-ref-repos.sh` with `set -euo pipefail`.
- `scripts/pull-ref-repos.sh` removes only the managed reference directories before refresh.
- `scripts/pull-ref-repos.sh` uses `git clone --depth 1 --filter=blob:none` for the three repos.
- `scripts/pull-ref-repos.sh` recreates the article snapshot directory and redownloads the linked Effect 4.0 beta page.
- Add root `AGENTS.md` that lists each reference asset, its path, and its role.
- `AGENTS.md` describes `opencode-azdo-extension` as the workflow reference and a negative security reference.
- `AGENTS.md` describes `tailcode` as the Bun CLI layout, `ox` tooling, and Effect+Bun style reference.
- `AGENTS.md` describes `effect-smol` as the canonical Effect v4 beta source reference.
- `AGENTS.md` describes the archived article as release-context reference material.

## Repository Layout
- Create `package.json`, `README.md`, `SECURITY.md`, `build.ts`, `tsconfig.json`, `.oxfmtrc.json`, `bin/open-azdo.ts`, `examples/azure-pipelines.review.yml`, and the `src/` and `test/` trees.
- Keep the main code layout as:
```text
bin/open-azdo.ts
src/main.ts
src/cli.ts
src/config.ts
src/errors.ts
src/logging.ts
src/git.ts
src/azure-devops.ts
src/opencode.ts
src/review-context.ts
src/review-prompt.ts
src/review-output.ts
src/thread-reconciliation.ts
test/*.test.ts
```
- Update `.gitignore` to ignore `.reference/`, `dist/`, `node_modules/`, coverage artifacts, and temp output.

## Package / Tooling Decisions
- Publish the package as `open-azdo`.
- Use `type: "module"` and `bin: { "open-azdo": "./dist/open-azdo.js" }`.
- Use `publishConfig.access: "public"`.
- Limit `files` in `package.json` to the built CLI and shipped docs.
- Set `"engines": { "bun": ">=1.3.10" }`.
- Use `@tsconfig/bun` and the `@effect/language-service` TypeScript plugin.
- Copy TailCode’s `ox` formatting style with `.oxfmtrc.json` set to `semi: false` and `printWidth: 120`.

## Dependency Baseline
- Pin `effect` to `4.0.0-beta.33`.
- Pin `@effect/platform-bun` to `4.0.0-beta.33`.
- Pin `@effect/language-service` to `0.80.0`.
- Pin `oxfmt` to `0.41.0`.
- Pin `oxlint` to `1.56.0`.
- Pin `@tsconfig/bun` to `1.0.10`.
- Pin `@types/bun` to `1.3.10`.
- Pin `typescript` to `5.9.3`.
- Do not add `@opencode-ai/sdk`.
- Do not add Azure DevOps SDK packages.
- Use Bun’s built-in test runner in v1 instead of Vitest.

## Scripts
- `typecheck`: `tsc -p tsconfig.json --noEmit`
- `fmt`: `oxfmt --write src bin test`
- `fmt:check`: `oxfmt --check src bin test`
- `lint`: `oxlint src bin test`
- `test`: `bun test`
- `check`: `bun run typecheck && bun run lint && bun run fmt:check && bun test`
- `build`: `bun run build.ts`
- `publish:dry`: `bun run check && bun run build && bun publish --dry-run`
- `publish:npm`: `bun run check && bun run build && bun publish`

## CLI Contract
- Publish one CLI binary: `open-azdo`.
- Expose one v1 subcommand: `open-azdo review`.
- Require `--model <provider/model>` or `OPEN_AZDO_MODEL`.
- Require Azure DevOps auth from `SYSTEM_ACCESSTOKEN`.
- Support `--workspace <path>` / `OPEN_AZDO_WORKSPACE` with default `BUILD_SOURCESDIRECTORY`.
- Support `--organization <name>` / `OPEN_AZDO_ORGANIZATION`.
- Support `--project <name>` / `OPEN_AZDO_PROJECT`.
- Support `--repository-id <id>` / `OPEN_AZDO_REPOSITORY_ID`.
- Support `--pull-request-id <id>` / `OPEN_AZDO_PULL_REQUEST_ID`.
- Support `--collection-url <url>` / `OPEN_AZDO_COLLECTION_URL`.
- Support `--agent <name>` / `OPEN_AZDO_AGENT` with default `azdo-review`.
- Support `--prompt-file <path>` / `OPEN_AZDO_PROMPT_FILE`.
- Support `--dry-run` to skip Azure DevOps mutations and print the validated review payload.
- Support `--json` to emit machine-readable CLI status.
- Exit `0` for successful review runs, even when findings are posted.
- Exit non-zero only for operational failures.

## Important Public Types / Interfaces
- `ReviewConfig`: resolved CLI and environment configuration.
- `AzureContext`: organization, project, collection URL, repository ID, pull request ID, and build metadata.
- `ReviewFinding`: `severity`, `confidence`, `title`, `body`, `filePath`, `line`, optional `endLine`, and optional `suggestion`.
- `ReviewResult`: `summary`, `verdict`, `findings`, and `unmappedNotes`.
- `ManagedThreadMarker`: deterministic marker data for summary and inline thread reconciliation.

## Runtime Design
- `bin/open-azdo.ts` is a thin Bun entrypoint that delegates to `src/main.ts`.
- `src/config.ts` loads flags and env, validates them with Effect Schema, and wraps secrets with `Redacted`.
- `src/logging.ts` provides sanitized structured logging and never renders redacted values.
- `src/git.ts` uses `Bun.spawn` with argument arrays only.
- `src/git.ts` never uses shell strings, `exec`, or `Bun.$`.
- Diff resolution is checkout-first and clone-free.
- If `HEAD` is a synthetic PR merge commit with two parents, diff `HEAD^1` against `HEAD`.
- Otherwise diff the checked-out source state against locally available target refs.
- If the needed git shape is missing, fail with a clear message telling the user to use `checkout: self` with `fetchDepth: 0`.
- `src/azure-devops.ts` uses Bun `fetch` wrapped in Effect for the minimal REST surface: PR metadata, existing threads, thread creation, comment updates, and stale-thread closure.
- `src/review-context.ts` builds AI input from PR title, PR description, changed file list, normalized unified diffs, and small file-content excerpts when needed.
- Existing PR conversation text is excluded from the AI prompt in v1.
- `src/opencode.ts` runs `opencode run --format json` directly.
- `src/opencode.ts` creates a temp OpenCode config directory for the run and removes it on scope exit.
- The generated `azdo-review` agent is read-only.
- The generated `azdo-review` agent allows only read/search/listing-style tools.
- The generated `azdo-review` agent denies shell, edit/write, web search, and network fetch tools.
- The generated `azdo-review` agent instructs the model to treat repo content and PR text as untrusted input.
- The prompt requires pure JSON output matching the repo’s `ReviewResult` schema.
- `src/review-output.ts` validates and normalizes model output with Effect Schema.
- Findings that cannot be mapped to changed lines become `unmappedNotes` instead of inline comments.
- `src/thread-reconciliation.ts` maintains one managed summary thread and one managed inline thread per finding fingerprint.
- Reruns update matching managed threads in place and mark stale managed finding threads as `fixed`.

## Commenting Strategy
- Post one top-level managed summary thread on every successful run.
- Post inline threads only for findings that map to changed lines.
- Post inline threads only for findings with `confidence` of `medium` or `high`.
- Keep `low` confidence findings in the summary only.
- Put verdict, severity counts, unmapped notes, build link, and the hidden reconciliation marker in the summary thread.
- Put title, severity, explanation, optional suggestion, and the hidden reconciliation marker in each inline thread.
- On fatal runtime failure, update or create the managed summary thread with the failure reason and exit non-zero.
- Never swallow comment-post failures.

## Security Defaults
- No PAT or OAuth token may appear in stdout, stderr, or thrown error messages.
- No authenticated git clone URLs.
- No repo edits, commits, or pushes in v1.
- No AI-executed helper scripts for comment posting.
- No long-lived OpenCode server and therefore no fixed-port conflict.
- No build-service write permissions beyond review-comment capabilities.
- Keep `persistCredentials: false` in the reference pipeline because the CLI does not need git auth after checkout.
- Document minimal Azure DevOps permissions as repository read plus pull request threads read/write.
- Treat PR text and repository content as untrusted input in prompts and agent instructions.

## Reference Pipeline File
- Add `examples/azure-pipelines.review.yml` as the canonical published-package example.
- The YAML is for Azure Repos build validation and uses `trigger: none`.
- The YAML uses `pool.vmImage: ubuntu-latest`.
- The YAML uses `checkout: self` with `clean: true`, `fetchDepth: 0`, and `persistCredentials: false`.
- The YAML downloads Bun `1.3.10` from the official asset `bun-linux-x64.zip`.
- The YAML downloads OpenCode `v1.2.27` from the official asset `opencode-linux-x64.tar.gz`.
- The YAML adds both tools to `PATH`.
- The YAML invokes the published package with `bunx open-azdo review --model "$(OpenCodeModel)"`.
- The YAML passes `SYSTEM_ACCESSTOKEN: $(System.AccessToken)` and provider API keys as env vars.
- The YAML comments explicitly note that “Allow scripts to access the OAuth token” must be enabled.
- The README explains that the pipeline should be attached as a branch build-validation policy.

## Documentation
- `README.md` explains what `open-azdo` does and why it differs from the marketplace extension.
- `README.md` shows published-package usage with `bunx open-azdo review`.
- `README.md` includes the Azure Pipeline example and the required env vars.
- `README.md` explains that findings are comment-only by default and do not fail the build.
- `SECURITY.md` explains the threat model and the v1 review-only boundary.
- `SECURITY.md` explains why checkout-first is used instead of tokenized clone URLs.
- `SECURITY.md` explains how secret redaction and read-only OpenCode permissions work.

## Tests and Acceptance Criteria
- Config tests verify required env and flags are enforced.
- Config tests verify `SYSTEM_COLLECTIONURI` parsing works for Azure DevOps Services and Server-style collection URLs.
- Logging tests verify secrets remain redacted in rendered config and error output.
- Git tests verify synthetic merge-commit diff resolution works.
- Git tests verify missing history yields the intended remediation error.
- Git tests verify no process path builds shell strings.
- OpenCode tests verify JSON event parsing extracts the final response correctly.
- OpenCode tests verify malformed output fails schema validation cleanly.
- OpenCode tests verify temp config directories are cleaned up after the run.
- Review-output tests verify invalid severities, paths, line numbers, and missing fields are rejected.
- Review-output tests verify low-confidence findings stay summary-only.
- Review-output tests verify unmapped findings never attempt inline posting.
- Azure DevOps tests verify summary thread create/update behavior.
- Azure DevOps tests verify finding fingerprints update existing threads instead of duplicating them.
- Azure DevOps tests verify stale managed finding threads are marked `fixed`.
- Azure DevOps tests verify comment-post failures surface as non-zero exits.
- Security regression tests verify tokens never appear in success or failure logs.
- End-to-end fixture tests run the CLI against a mocked Azure DevOps API and a fixture git repo and verify summary posting, inline posting, reconciliation markers, and exit code `0` when findings exist.

## Assumptions and Defaults
- Versions are pinned to the newest observed values as of March 17, 2026.
- The package name will be `open-azdo`; it is currently available on npm.
- The canonical consumer flow is the published-package path with `bunx open-azdo review`.
- The CLI is optimized for Azure Pipelines build-validation usage first.
- The inspiration repo’s arbitrary command mode is intentionally out of scope for v1.
