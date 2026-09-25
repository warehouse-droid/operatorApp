#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_root"
artifact=server/test-artifacts/group-load-identity
mkdir -p "$artifact/baseline/src"
cp server/src/co-source-packing-handoff.js server/src/delivery-repository.js "$artifact/baseline/src/"
patch --batch -p1 -d "$artifact/baseline" < server/test/support/group-load-identity-baseline.patch
if GROUP_LOAD_IDENTITY_BASELINE=1 bash server/tools/group-load-identity-test.sh node --test test/mbt/integration/group-load-identity.test.js > "$artifact/red.log" 2>&1; then
  echo 'Expected the baseline grouped identity regressions to fail' >&2
  exit 1
fi
GROUP_LOAD_IDENTITY_BASELINE=1 bash server/tools/group-load-identity-test.sh node tools/group-load-identity-checks.mjs baseline
bash server/tools/group-load-identity-test.sh node tools/group-load-identity-checks.mjs suite
bash server/tools/group-load-identity-test.sh node tools/group-load-identity-checks.mjs coverage
bash server/tools/group-load-identity-test.sh node tools/group-load-identity-checks.mjs mutations
