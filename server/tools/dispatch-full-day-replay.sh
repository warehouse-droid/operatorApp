#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
bash server/tools/dispatch-freshness-test.sh node --test test/dispatch/frontend/dispatch-full-day.browser.test.mjs
