#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact="server/test-artifacts/split-inbound-completion"
python3 server/tools/split-inbound-completion-baseline.py
SPLIT_INBOUND_COMPLETION_BASELINE=1 bash server/tools/split-inbound-completion-test.sh node tools/split-inbound-completion-suite.mjs --baseline > "$artifact/baseline-suite.log" 2>&1
bash server/tools/split-inbound-completion-test.sh node tools/split-inbound-completion-suite.mjs > "$artifact/suite.log" 2>&1
bash server/tools/split-inbound-completion-test.sh node tools/split-inbound-completion-checks.mjs > "$artifact/checks.log" 2>&1
python3 server/tools/split-inbound-completion-coverage.py > "$artifact/changed-coverage.log"
bash server/tools/split-inbound-completion-test.sh node tools/split-inbound-completion-types.mjs > "$artifact/types.log" 2>&1
bash server/tools/split-inbound-completion-test.sh node tools/split-inbound-completion-mutations.mjs > "$artifact/mutations.log" 2>&1
bash server/tools/split-inbound-completion-test.sh node --test test/mbt/integration/split-inbound-completion-refresh.test.js > "$artifact/refresh-tests.log" 2>&1
python3 server/tools/split-inbound-completion-evidence.py
