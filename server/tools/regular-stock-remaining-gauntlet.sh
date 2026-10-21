#!/usr/bin/env bash
set -euo pipefail
remaining_repo=$(cd "$(dirname "$0")/../.." && pwd)
python3 - "$remaining_repo" <<'PY'
import json,difflib,shutil,sys
from pathlib import Path
root=Path(sys.argv[1])/'server'; out=root/'test-artifacts/regular-stock-remaining-20261016'; baseline=out/'baseline'
changed={}
for name in json.loads((baseline/'files.json').read_text()):
 before=(baseline/name).read_text().splitlines(); after=(root/name).read_text().splitlines()
 changed[name]=[i+1 for tag,_,_,start,end in difflib.SequenceMatcher(a=before,b=after).get_opcodes() if tag in ('insert','replace') for i in range(start,end)]
(out/'changed-lines.json').write_text(json.dumps(changed,indent=2)+'\n')
snapshot=out/'snapshot'
for name in ['src','public','test','contracts','migrations']:
 shutil.copytree(root/name,snapshot/name,dirs_exist_ok=True)
shutil.copy2(root/'package.json',snapshot/'package.json')
PY
export REMAINING_SOURCE="$remaining_repo/server/test-artifacts/regular-stock-remaining-20261016/snapshot"
chown -R 1000:1000 "$REMAINING_SOURCE"
bash "$remaining_repo/server/tools/regular-stock-remaining-run.sh" final 'node tools/regular-stock-remaining-checks.mjs final'
bash "$remaining_repo/server/tools/regular-stock-remaining-run.sh" reverse 'node tools/regular-stock-remaining-checks.mjs reverse'
