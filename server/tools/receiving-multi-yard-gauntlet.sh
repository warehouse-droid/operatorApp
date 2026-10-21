#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
bash tools/receiving-multi-yard-test.sh node tools/receiving-multi-yard-gauntlet.mjs "$@"
