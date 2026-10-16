#!/usr/bin/env bash
set -euo pipefail
reconnect_repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$reconnect_repo"
reconnect_release="$reconnect_repo/server/deployments/driver-reconnect-20261016"
reconnect_artifacts="$reconnect_repo/server/test-artifacts/driver-reconnect-20261016"
export RECOVERY_SOURCE="$reconnect_release/candidate"
export RECOVERY_ARTIFACTS="$reconnect_artifacts/release-validation"
# Each underlying runner registers bounded-container teardown before startup.
bash server/tools/driver-reconnect-unit.sh app 'node tools/driver-reconnect-checks.mjs && node tools/driver-reconnect-dispatch-check.mjs'
RECOVERY_PHASE=release-app bash server/tools/driver-reconnect-browser.sh
RECOVERY_SOURCE="$reconnect_release/worker-candidate" RECOVERY_PHASE=release-worker RECOVERY_BILLING_ONLY=1 bash server/tools/driver-reconnect-browser.sh
python3 - "$reconnect_artifacts" <<'PY'
from pathlib import Path
import shutil,sys
root=Path(sys.argv[1]);src=root/'browser-release-app/results';dst=root/'release-validation/browser-release-app/results'
if (dst/'server-coverage').exists(): shutil.rmtree(dst/'server-coverage')
shutil.copytree(src/'server-coverage',dst/'server-coverage')
for p in src.rglob('*driver-coverage.json'):
    out=dst/p.relative_to(src);out.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,out)
PY
bash server/tools/driver-reconnect-unit.sh coverage 'RECOVERY_COVERAGE_PHASE=browser-release-app node tools/driver-reconnect-coverage.mjs'
# validate also checks the captured production base has not changed; after a
# deployment, the individual test/coverage results remain the reproducible proof.
RECOVERY_RELEASE_INTEGRATION_PHASE=browser-release-app python3 server/tools/driver-reconnect-release.py validate
