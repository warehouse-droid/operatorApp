#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
artifact="$repo/server/test-artifacts/transfer-yard-posting-20261021"
# Only generated final evidence is replaced. Retain RED logs and original sources.
rm -rf "$artifact/final"
mkdir -p "$artifact/final"
bash server/tools/transfer-yard-posting-test.sh node tools/transfer-yard-posting-checks.mjs all > "$artifact/final/run.log" 2>&1
python3 server/tools/transfer-yard-posting-report.py
