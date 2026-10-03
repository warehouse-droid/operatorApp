#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
artifact=test-artifacts/boss-search-history-20261003
python3 - <<'PY'
from pathlib import Path
import json,difflib
base=Path('test-artifacts/boss-search-history-20261003')
changed={};diff=''
for f in json.loads(Path('tools/boss-history-files.json').read_text()):
    old=(base/'before'/f).read_text();new=Path(f).read_text()
    diff+=''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+f,tofile='b/'+f))
    changed[f]=[n+1 for op,a,b,c,d in difflib.SequenceMatcher(a=old.splitlines(),b=new.splitlines(),autojunk=False).get_opcodes() if op in ('replace','insert') for n in range(c,d)]
    assert all(not new.splitlines()[n-1].endswith((' ','\t')) for n in changed[f]),f+' has new trailing whitespace'
(base/'task.diff').write_text(diff);(base/'changed-lines.json').write_text(json.dumps(changed,indent=2)+'\n')
PY
bash tools/boss-test-env.sh start
cleanup() {
  docker exec mbbs-boss-test-runner tar -C /app/test-artifacts -cf - boss-search-history-20261003 | tar -C test-artifacts -xf -
  bash tools/boss-test-env.sh stop
}
trap cleanup EXIT
docker exec mbbs-boss-test-runner node src/migrate.js > "$artifact/migrations.log" 2>&1
docker exec mbbs-boss-test-runner node tools/boss-history-gauntlet.mjs > "$artifact/gauntlet-run.log" 2>&1
docker exec mbbs-boss-test-runner node tools/boss-history-secrets.mjs > "$artifact/secrets.log" 2>&1
