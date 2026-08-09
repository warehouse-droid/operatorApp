#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${SCM_TRANSFER_ARTIFACT_DIR:-test-artifacts/scm-transfer-dependency}"
mkdir -p "${artifact_dir}"
run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
log_path="${artifact_dir}/gauntlet-${run_stamp}.log"

{
  npm run test:scm-transfer-workflow
  npm run test:scm-transfer-coverage
  npm run test:order-dependencies
  npm run mutate:scm-transfer-workflow
  npm run syntax:legacy
} 2>&1 | tee "${log_path}"

cp "${log_path}" "${artifact_dir}/latest.log"
echo "SCM transfer-dependency gauntlet passed: ${log_path}"
