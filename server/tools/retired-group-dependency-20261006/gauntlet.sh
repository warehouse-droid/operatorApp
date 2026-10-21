#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"
artifact="server/test-artifacts/retired-group-dependency-20261006"
python3 - <<'PY'
import difflib,json
from pathlib import Path
root=Path('server')
old=(root/'test-artifacts/retired-group-dependency-20261006/baseline/src/order-dependency-repository.js').read_text().splitlines()
new=(root/'src/order-dependency-repository.js').read_text().splitlines()
added=[]
for kind,old_start,old_end,new_start,new_end in difflib.SequenceMatcher(None,old,new,autojunk=False).get_opcodes():
    if kind in ('insert','replace'):
        added.extend(i+1 for i in range(new_start,new_end) if new[i].strip() and not new[i].lstrip().startswith('//'))
(root/'test-artifacts/retired-group-dependency-20261006/changed-lines.json').write_text(json.dumps(added)+'\n')
PY
RETIRED_GROUP_BASELINE=1 bash server/tools/retired-group-dependency-20261006/test.sh \
  node tools/retired-group-dependency-20261006/gauntlet.mjs baseline > "$artifact/baseline-gauntlet.log" 2>&1
bash server/tools/retired-group-dependency-20261006/test.sh \
  node tools/retired-group-dependency-20261006/gauntlet.mjs final > "$artifact/final-gauntlet.log" 2>&1
