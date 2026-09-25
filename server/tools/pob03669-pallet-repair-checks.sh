#!/usr/bin/env bash
# Run with sudo after the capture command. Every mutation below rolls back.
set -Eeuo pipefail
repair_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repair_backup=/home/ubuntu/operatorapp-deploy-backups/pob03669-pallet-repair-20260916
test -f "$repair_backup/evidence.json"
umask 077
python3 - "$repair_root/server/tools/pob03669-pallet-repair.py" <<'PY'
import ast,pathlib,sys
ast.parse(pathlib.Path(sys.argv[1]).read_text())
PY
docker exec -i mbbs-operator-app-app-1 node --check --input-type=module < "$repair_root/server/tools/pob03669-pallet-repair.mjs"
repair_mounts=(-v "$repair_root/server/src:/app/src:ro" -v "$repair_root/server/test:/app/test:ro" -v "$repair_root/server/tools:/app/tools:ro")
docker run --rm -i --network none "${repair_mounts[@]}" --entrypoint node mbbs-retired-confirm-test:20260914 --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanTextForSecrets } from '/app/test/support/scan-diff-secrets.mjs';
for (const name of ['pob03669-pallet-repair.mjs','pob03669-pallet-repair.py','pob03669-pallet-repair-checks.sh']) {
  assert.deepEqual(scanTextForSecrets(readFileSync('/app/tools/' + name,'utf8'), name), []);
}
console.log('Syntax and credential scan passed.');
JS
docker run --rm --network none "${repair_mounts[@]}" --entrypoint node mbbs-retired-confirm-test:20260914 --test \
  test/mbt/unit/scm-receipt-source-reference.test.js \
  test/mbt/property/scm-ir-split-reference.property.test.js \
  test/mbt/unit/scm-split-receipt-allocation.red.test.js \
  test/mbt/unit/scm-ir-split-reference.red.test.js > "$repair_backup/regression.log" 2>&1
tail -9 "$repair_backup/regression.log"
for repair_fault in quantity orderline source; do
  python3 "$repair_root/server/tools/pob03669-pallet-repair.py" rehearse --fault "$repair_fault"
done
python3 "$repair_root/server/tools/pob03669-pallet-repair.py" rehearse
