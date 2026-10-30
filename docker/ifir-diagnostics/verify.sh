#!/usr/bin/env bash
set -Eeuo pipefail
diagnostics_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "$diagnostics_dir/check.sh"
bash "$diagnostics_dir/check.sh" python python_gauntlet.py
