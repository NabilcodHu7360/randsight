#!/usr/bin/env bash
# Build the Chrome Web Store package.
#
# An ALLOWLIST, deliberately. An exclude-list quietly ships whatever you forgot
# to exclude — node_modules, test fixtures, a stray dev script — and a reviewer
# reading a mocked `chrome` API in a test harness is a conversation nobody wants
# to have.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-randbats-live.zip}"
rm -f "$OUT"

zip -qr "$OUT" \
  manifest.json \
  src \
  popup \
  guide \
  icons \
  LICENSE \
  THIRD-PARTY-LICENSES.txt \
  PRIVACY.md \
  -x '*.DS_Store' -x '*/.*'

echo "$OUT"
unzip -l "$OUT" | tail -1
