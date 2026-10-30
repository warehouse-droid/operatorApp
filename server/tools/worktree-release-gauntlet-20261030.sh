#!/usr/bin/env bash
# Re-run the full comparison, focused checks, and prepared-image rehearsal.
# Requires the release metadata created by worktree-release-20261030.py prepare/build.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if ! python3 docker/retention/retention.py run -- \
  python3 server/tools/worktree-release-checks-20261030.py; then
  python3 docker/retention/retention.py run -- \
    python3 server/tools/worktree-release-recheck-20261030.py
fi
python3 docker/retention/retention.py run -- \
  python3 server/tools/worktree-release-final-checks-20261030.py
