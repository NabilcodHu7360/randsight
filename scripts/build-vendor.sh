#!/usr/bin/env bash
# Regenerate src/vendor/calc.js — the vendored @smogon/calc bundle.
#
# The bundle is committed so the extension loads unpacked with no build step.
# Re-run this only when bumping the calc library.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
npm init -y >/dev/null
# Pinned. An unpinned install makes "regenerate this yourself and compare"
# untrue the moment either package publishes a new version.
CALC_VERSION="0.11.0"
ESBUILD_VERSION="0.25.10"
npm install "@smogon/calc@${CALC_VERSION}" "esbuild@${ESBUILD_VERSION}" >/dev/null

VERSION="$(node -e "console.log(require('@smogon/calc/package.json').version)")"

cat > entry.js <<'JS'
// Bundle entry: expose exactly the pieces the extension uses on one global.
import { Generations, Pokemon, Move, Field, Side, calculate } from '@smogon/calc';
globalThis.RBLCalcLib = { Generations, Pokemon, Move, Field, Side, calculate };
JS

# NOT minified, deliberately: a single-line 480 KB bundle inside a content
# script reads as obfuscation to a Web Store reviewer, and nobody can audit it.
#
# --legal-comments=inline is set, but note it only preserves comments marked
# /*! or @license. @smogon/calc's own attributions (ts-essentials, and a
# jQuery-derived type table that IS present in the output) are plain // comments
# and do not survive bundling either way. Those notices are reproduced in
# THIRD-PARTY-LICENSES.txt instead, which is what actually satisfies MIT here.
npx esbuild entry.js \
  --bundle --format=iife --target=chrome111 --legal-comments=inline \
  --banner:js="/* @smogon/calc v${VERSION} (MIT) — vendored bundle. Do not edit by hand; regenerate with scripts/build-vendor.sh */" \
  --outfile="$ROOT/src/vendor/calc.js"

echo "wrote src/vendor/calc.js  (@smogon/calc v${VERSION}, esbuild ${ESBUILD_VERSION}, unminified)"
echo "size: $(wc -c < "$ROOT/src/vendor/calc.js") bytes"
