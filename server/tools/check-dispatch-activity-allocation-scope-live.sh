#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
if [[ "${1:-}" == deployed ]]; then
  sed 's|"../src/|"./src/|g' server/tools/replay-dispatch-activity-allocation-scope.mjs |
    docker exec -i mbbs-operator-app-app-1 node --input-type=module
  exit
fi
# Stream source code only into a temporary Node process. Production modules and
# database data are never changed or copied; results contain only assertions.
python3 - <<'PY' | docker exec -i mbbs-operator-app-app-1 node --input-type=module
from pathlib import Path
import base64

def module_url(source):
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()

load = Path('server/src/dispatch-load-assignment.js').read_text().replace('"./', '"file:///app/src/')
load_url = module_url(load)
policy = Path('server/src/dispatch-planner-performance.js').read_text().replace('"./dispatch-load-assignment.js"', '"' + load_url + '"').replace('"./', '"file:///app/src/')
replay = Path('server/tools/replay-dispatch-activity-allocation-scope.mjs').read_text()
replay = replay.replace('"../src/dispatch-load-assignment.js"', '"' + load_url + '"')
replay = replay.replace('"../src/dispatch-planner-performance.js"', '"' + module_url(policy) + '"')
print(replay.replace('"../src/', '"file:///app/src/'))
PY
