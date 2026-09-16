#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact="server/test-artifacts/blanket-auto-resume"
python3 server/tools/blanket-auto-resume-baseline.py
bash server/tools/blanket-auto-resume-test.sh node tools/blanket-auto-resume-suite.mjs > "$artifact/suite.log" 2>&1
bash server/tools/blanket-auto-resume-test.sh node tools/blanket-auto-resume-checks.mjs > "$artifact/checks.log" 2>&1
python3 server/tools/blanket-auto-resume-coverage.py > "$artifact/changed-coverage.log"
bash server/tools/blanket-auto-resume-test.sh node tools/blanket-auto-resume-types.mjs > "$artifact/types.log" 2>&1
bash server/tools/blanket-auto-resume-test.sh node tools/blanket-auto-resume-mutations.mjs > "$artifact/mutations.log" 2>&1
