#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF_DIR="${ROOT_DIR}/.reference"

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--effect-only" ) ]]; then
  echo "Usage: $0 [--effect-only]" >&2
  exit 1
fi

mkdir -p "${REF_DIR}"

if [[ "${1:-}" != "--effect-only" ]]; then
  rm -rf \
    "${REF_DIR}/opencode" \
    "${REF_DIR}/opencode-azdo-extension" \
    "${REF_DIR}/tailcode" \
    "${REF_DIR}/t3code"

  git clone --depth 1 --filter=blob:none https://github.com/sst/opencode.git "${REF_DIR}/opencode"
  git clone --depth 1 --filter=blob:none https://github.com/trojanmartin/opencode-azdo-extension.git "${REF_DIR}/opencode-azdo-extension"
  git clone --depth 1 --filter=blob:none https://github.com/kitlangton/tailcode.git "${REF_DIR}/tailcode"
  git clone --depth 1 --filter=blob:none https://github.com/pingdotgg/t3code.git "${REF_DIR}/t3code"
fi

rm -rf "${REF_DIR}/effect-smol" "${REF_DIR}/effect"
git clone --depth 1 --filter=blob:none --branch 'effect@4.0.0' \
  https://github.com/Effect-TS/effect.git "${REF_DIR}/effect"

# Keep the source reference aligned with the exact stable runtime release.
EFFECT_COMMIT="67ba4e46a11ccda0b6761578bfd22c04ae00167d"
if [[ "$(git -C "${REF_DIR}/effect" rev-parse HEAD)" != "${EFFECT_COMMIT}" ]]; then
  echo "Effect reference does not match the pinned 4.0.0 release commit." >&2
  exit 1
fi
