#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
unset INVENTORY_SOURCE_ROOT
export INVENTORY_TEST_NAME=mbbs-operator-inventory-test
artifacts="$PWD/test-artifacts/control-damage"
mkdir -p "$artifacts"
python3 - <<'PY'
import hashlib,json
from pathlib import Path
files=json.loads(Path('test/support/control-damage-changed-lines.json').read_text())
Path('test-artifacts/control-damage/full-sources-start.json').write_text(json.dumps({p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files},sort_keys=True))
PY
bash tools/operator-inventory-env.sh stop
bash tools/operator-inventory-env.sh start
bash tools/operator-inventory-env.sh exec npm run migrate > "$artifacts/final-migration.log" 2>&1
bash tools/operator-inventory-env.sh exec npm test > "$artifacts/full.log" 2>&1 || true
docker exec -i "$INVENTORY_TEST_NAME-runner" sh -c 'mkdir -p /app/test-artifacts/operator-inventory; cat > /app/test-artifacts/operator-inventory/full.log' < "$artifacts/full.log"
bash tools/operator-inventory-env.sh exec node tools/operator-inventory-checks.mjs compare > "$artifacts/comparison.log" 2>&1
docker exec "$INVENTORY_TEST_NAME-runner" cat /app/test-artifacts/operator-inventory/comparison.json > "$artifacts/comparison.json"
python3 - <<'PY'
import hashlib,json
from pathlib import Path
before=json.loads(Path('test-artifacts/control-damage/full-sources-start.json').read_text())
assert before=={p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in before},'Production code changed during the full suite'
PY
cat "$artifacts/comparison.log"
