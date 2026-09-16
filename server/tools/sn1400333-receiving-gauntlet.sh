#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Each full-suite run owns a fresh database; focused fixtures cannot contaminate it.
bash tools/operator-receiving-identity-test.sh node tools/sn1400333-receiving-gauntlet.mjs --baseline-full
bash tools/operator-receiving-identity-test.sh node tools/sn1400333-receiving-gauntlet.mjs --full
bash tools/operator-receiving-identity-test.sh node tools/sn1400333-receiving-gauntlet.mjs
python3 tools/sn1400333-receiving-results.py
