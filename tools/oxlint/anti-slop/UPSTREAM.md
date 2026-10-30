# Anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7`
- Copied from: `skills/install-anti-slop/assets/anti-slop/` at that commit.
- Installed paths: `tools/oxlint/anti-slop/index.ts` and `tools/oxlint/anti-slop/effect/index.ts`, with their supporting rules, shared helpers, and vendored files.
- Verification: every installed skill file matched its Git blob at the source commit before copying; the plugin assets are unmodified.
- Intentional deviations: none. This provenance file is repository-local metadata.

The nested `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md` retain the readability rule's license and provenance.
Generic and Effect rules are enabled in `.oxlintrc.json`. Keep `@oxlint/plugins` and `oxlint` pinned to the same exact version when upgrading.
The Effect service-import rule currently checks relative project imports; package aliases are outside its enforcement.
