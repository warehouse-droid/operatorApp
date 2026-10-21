#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
python3 server/tools/dispatch-freshness-lines.py
bash server/tools/dispatch-freshness-test.sh node tools/dispatch-freshness-quality.mjs
python3 server/tools/dispatch-full-day-report.py
python3 server/tools/dispatch-freshness-evidence.py
python3 server/tools/dispatch-consistency-evidence.py
