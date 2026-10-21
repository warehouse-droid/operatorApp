#!/usr/bin/env bash
set -euo pipefail
recovery_repo=$(cd "$(dirname "$0")/../.." && pwd)
export RECOVERY_SOURCE=${RECOVERY_SOURCE:-"$recovery_repo/server/deployments/driver-upload-recovery-20261015/candidate"}
export RECOVERY_PHASE=final
bash "$recovery_repo/server/tools/driver-upload-recovery-unit.sh" final 'node tools/driver-upload-recovery-checks.mjs'
bash "$recovery_repo/server/tools/driver-upload-recovery-browser.sh"
bash "$recovery_repo/server/tools/driver-upload-recovery-unit.sh" evidence 'node tools/driver-upload-recovery-evidence.mjs'
