#!/usr/bin/env bash
# Re-run the offline gauntlet without overwriting the retained release evidence.
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
prefix="replay-$(date -u +%Y%m%d%H%M%S)"
out="$root/server/test-artifacts/request-loading-performance-20261008"
runner="$root/server/tools/request-loading-20261008/run.sh"
REQUEST_LOADING_STAGE=before REQUEST_LOADING_RUN="$prefix-baseline" \
  bash "$runner" node tools/request-loading-20261008/regression.mjs > "$out/$prefix-baseline.log" 2>&1
REQUEST_LOADING_STAGE=candidate REQUEST_LOADING_RUN="$prefix-regression" \
  bash "$runner" node tools/request-loading-20261008/regression.mjs > "$out/$prefix-regression.log" 2>&1
REQUEST_LOADING_STAGE=candidate REQUEST_LOADING_RUN="$prefix-rebase" \
  bash "$runner" node tools/request-loading-20261008/rebase-checks.mjs > "$out/$prefix-rebase.log" 2>&1
REQUEST_LOADING_STAGE=candidate REQUEST_LOADING_RUN="$prefix-final" \
  bash "$runner" node tools/request-loading-20261008/checks.mjs > "$out/$prefix-final.log" 2>&1
python3 - "$out" "$prefix" <<'PY'
import json,sys
from pathlib import Path
out=Path(sys.argv[1]);prefix=sys.argv[2]
result={}
for name,kind in [('baseline','regression'),('regression','regression'),('rebase','rebase'),('final','checks')]:
    result[name]=json.loads((out/(prefix+'-'+name)/'results'/kind/'stages.json').read_text())
print(json.dumps({'prefix':prefix,'stages':result,'note':'Compare baseline and candidate diagnostics; preserved live read-only evidence is separate.'},indent=2))
PY
