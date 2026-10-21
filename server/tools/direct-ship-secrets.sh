#!/usr/bin/env bash
set -Eeuo pipefail
node test/support/scan-diff-secrets.mjs --unified-diff /workspace/server/test-artifacts/direct-ship-lifecycle-20260925/task.diff > test-artifacts/secrets.log 2>&1
