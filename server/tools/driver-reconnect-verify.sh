#!/usr/bin/env bash
set -euo pipefail
verify_repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$verify_repo"
verify_artifacts="$verify_repo/server/test-artifacts/driver-reconnect-20261016"
# Each runner registers teardown before starting its bounded disposable tests.
# Raw unit coverage is cleared by checks.mjs; the browser gets a fresh directory.
verify_phase="verified-$(date -u +%Y%m%dT%H%M%SZ)"
python3 - "$verify_repo" <<'PY'
import pathlib,json,difflib,sys
s=pathlib.Path(sys.argv[1])/'server'; a=s/'test-artifacts/driver-reconnect-20261016'
names=list(json.loads((a/'final/runtime-hashes.json').read_text()))
if 'migrations/295_driver_upload_recovery_audit.sql' not in names:names.append('migrations/295_driver_upload_recovery_audit.sql')
patch=[]
for name in names:
 before=(a/'baseline'/name).read_text().splitlines(True) if (a/'baseline'/name).exists() else []
 patch.extend(difflib.unified_diff(before,(s/name).read_text().splitlines(True),fromfile='a/'+name,tofile='b/'+name))
(a/'runtime.patch').write_text(''.join(patch))
PY
bash server/tools/driver-reconnect-unit.sh "$verify_phase" 'node tools/driver-reconnect-checks.mjs && node tools/driver-reconnect-dispatch-check.mjs'
RECOVERY_PHASE="$verify_phase" bash server/tools/driver-reconnect-browser.sh
R2_CLEANUP_MODE=verify bash server/tools/driver-reconnect-r2.sh
bash server/tools/driver-reconnect-unit.sh "$verify_phase-evidence" "RECOVERY_COVERAGE_PHASE=browser-$verify_phase node tools/driver-reconnect-coverage.mjs && RECOVERY_COVERAGE_PHASE=browser-$verify_phase node tools/driver-reconnect-evidence.mjs"
