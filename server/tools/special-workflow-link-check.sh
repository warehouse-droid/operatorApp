#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
python3 - <<'PY'
from pathlib import Path
import difflib,json
out=Path('test-artifacts/special-workflow-review/so-po-native')
files=json.loads((out/'runtime-files.json').read_text())
diff=[]
for f in files:
 diff.extend(difflib.unified_diff((out/'baseline'/f).read_text().splitlines(True),Path(f).read_text().splitlines(True),fromfile='a/server/'+f,tofile='b/server/'+f,n=0))
(out/'runtime.diff').write_text(''.join(diff))
PY
sudo -n docker exec -w /app -e MBT_TEST_ISOLATED=1 \
  -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify \
  mbbs-special-review-runner node tools/special-workflow-link-check.mjs
