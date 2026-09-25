#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
candidate_label="${1:-candidate-$(date -u +%Y%m%d-%H%M%S)}"
python3 tools/netsuite-priority-queue-gauntlet.py "$candidate_label"
python3 tools/netsuite-priority-queue-prepare.py "$candidate_label"
