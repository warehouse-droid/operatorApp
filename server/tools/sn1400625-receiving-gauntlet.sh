#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
bash tools/operator-receiving-identity-test.sh node tools/sn1400625-receiving-checks.mjs --baseline-full
bash tools/operator-receiving-identity-test.sh node tools/sn1400625-receiving-checks.mjs --full
bash tools/operator-receiving-identity-test.sh node tools/sn1400625-receiving-checks.mjs --compare-full
if [[ "${SN1400625_LIVE_REPLAY:-0}" == "1" ]]; then
  python3 tools/sn1400625-receiving-live.py
fi
python3 tools/sn1400625-receiving-results.py
