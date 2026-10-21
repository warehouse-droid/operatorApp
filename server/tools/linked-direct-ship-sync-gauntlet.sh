#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
bash server/tools/linked-direct-ship-sync-test.sh node tools/linked-direct-ship-sync-checks.mjs
python3 server/tools/linked-direct-ship-sync-coverage.py
git diff --check -- server/src/order-sync-repository.js server/src/order-dependency-repository.js server/src/direct-to-completion-repository.js
