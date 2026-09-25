#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact=server/test-artifacts/scm-to-untouched-lines
mkdir -p "$artifact/baseline"
cp server/src/scm-dependency-preview-service.js "$artifact/baseline/scm-dependency-preview-service.js"
patch --silent "$artifact/baseline/scm-dependency-preview-service.js" < server/test/support/scm-to-untouched-lines-baseline.patch
runner=(bash server/tools/scm-to-untouched-lines-test.sh)
baseline="$repo_root/$artifact/baseline/scm-dependency-preview-service.js"
sha256sum server/src/scm-dependency-preview-service.js > "$artifact/final-source.sha256"
SCM_TO_SOURCE="$baseline" "${runner[@]}" node --test test/dispatch/integration/scm-to-untouched-lines.test.js > "$artifact/red-final.log" 2>&1 && exit 1
python3 - <<'PY'
from pathlib import Path
log = Path('server/test-artifacts/scm-to-untouched-lines/red-final.log').read_text()
assert '# tests 45' in log and '# fail 13' in log and "code: 'ERR_ASSERTION'" in log
assert 'SyntaxError' not in log and 'ERR_MODULE_NOT_FOUND' not in log
PY
"${runner[@]}" node tools/scm-to-untouched-lines-checks.mjs > "$artifact/checks-run.log" 2>&1
SCM_TO_SOURCE="$baseline" "${runner[@]}" npm run typecheck:mbt > "$artifact/types-baseline.log" 2>&1 || true
"${runner[@]}" npm run typecheck:mbt > "$artifact/types-final.log" 2>&1 || true
SCM_TO_SOURCE="$baseline" "${runner[@]}" npm test > "$artifact/full-baseline.log" 2>&1 || true
"${runner[@]}" npm test > "$artifact/full-final.log" 2>&1 || true
python3 server/tools/scm-to-untouched-lines-deploy.py check
"${runner[@]}" node test/support/scan-diff-secrets.mjs src/scm-dependency-preview-service.js \
  test/dispatch/integration/scm-to-untouched-lines.test.js test/support/scm-to-untouched-lines-loader.mjs \
  test/support/scm-to-untouched-lines-baseline.patch tools/scm-to-untouched-lines-checks.mjs \
  tools/scm-to-untouched-lines-live.mjs tools/scm-to-untouched-lines-test.sh \
  tools/scm-to-untouched-lines-gauntlet.sh tools/scm-to-untouched-lines-deploy.py \
  test/scm-to-untouched-lines-spec.md test/scm-to-untouched-lines-evidence.md > "$artifact/secrets-final.log" 2>&1
python3 -m py_compile server/tools/scm-to-untouched-lines-deploy.py
bash -n server/tools/scm-to-untouched-lines-test.sh server/tools/scm-to-untouched-lines-gauntlet.sh
sha256sum --check "$artifact/final-source.sha256"
git diff --check
