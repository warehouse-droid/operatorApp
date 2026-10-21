#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
task_root="$server_root/tools/po-line-identity-20261015"
python3 "$task_root/rebase.py" sync
python3 "$task_root/run.py" regression-baseline
python3 "$task_root/run.py" static-baseline
python3 "$task_root/run.py" final
python3 "$task_root/run.py" history-baseline
python3 "$task_root/run.py" history-candidate
python3 "$task_root/history-compare.py"
