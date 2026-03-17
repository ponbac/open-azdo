#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF_DIR="${ROOT_DIR}/.reference"

rm -rf \
  "${REF_DIR}/opencode-azdo-extension" \
  "${REF_DIR}/tailcode" \
  "${REF_DIR}/effect-smol" \
  "${REF_DIR}/effect-4.0-beta-article"

mkdir -p "${REF_DIR}"

git clone --depth 1 --filter=blob:none https://github.com/trojanmartin/opencode-azdo-extension.git "${REF_DIR}/opencode-azdo-extension"
git clone --depth 1 --filter=blob:none https://github.com/kitlangton/tailcode.git "${REF_DIR}/tailcode"
git clone --depth 1 --filter=blob:none https://github.com/Effect-TS/effect-smol.git "${REF_DIR}/effect-smol"

mkdir -p "${REF_DIR}/effect-4.0-beta-article"
curl -fsSL https://effect.website/blog/releases/effect/40-beta/ \
  -o "${REF_DIR}/effect-4.0-beta-article/index.html"
