#!/usr/bin/env bash

set -euo pipefail

mode="${1:-publish}"

if [[ -z "${NPM_CONFIG_TOKEN:-}" && -f "${HOME}/.npmrc" ]]; then
  token="$(sed -n 's#^//registry\.npmjs\.org/:_authToken=##p' "${HOME}/.npmrc" | head -n1)"
  if [[ -n "${token}" ]]; then
    export NPM_CONFIG_TOKEN="${token}"
  fi
fi

if [[ -z "${NPM_CONFIG_TOKEN:-}" ]]; then
  echo "Missing npm auth token. Run 'bunx npm login' or export NPM_CONFIG_TOKEN." >&2
  exit 1
fi

bun run ./scripts/publish-npm.ts "${mode}"
