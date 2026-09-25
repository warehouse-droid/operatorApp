#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact=test-artifacts/link-to-fix/final-v3
mkdir -p "$artifact"
run=(bash tools/operator-display-test.sh)
"${run[@]}" unit node tools/link-to-fix-checks.mjs source
"${run[@]}" unit node tools/link-to-fix-checks.mjs static > "$artifact/static.log" 2>&1
"${run[@]}" db node tools/link-to-fix-focused.mjs > "$artifact/focused.log" 2>&1
"${run[@]}" unit node tools/link-to-fix-checks.mjs coverage > "$artifact/coverage.log" 2>&1
"${run[@]}" db node tools/link-to-fix-checks.mjs mutation > "$artifact/mutations.log" 2>&1
"${run[@]}" db node tools/link-to-fix-checks.mjs health > "$artifact/health.log" 2>&1
"${run[@]}" browser node tools/link-to-fix-browser.mjs final-v3 > "$artifact/browser.log" 2>&1
set +e
"${run[@]}" db npm test > "$artifact/full.log" 2>&1
full_status=$?
set -e
if [[ "$full_status" -gt 1 ]]; then exit "$full_status"; fi
"${run[@]}" unit node tools/link-to-fix-checks.mjs compare > "$artifact/full-comparison.log" 2>&1
"${run[@]}" unit node tools/link-to-fix-checks.mjs secrets > "$artifact/secrets.log" 2>&1
python3 - <<'PY_CHECK'
from pathlib import Path
import json
for change in json.loads(Path('test/support/link-to-fix-changes.json').read_text()):
    lines=Path(change['file']).read_text().splitlines()
    assert all(lines[number-1]==lines[number-1].rstrip() for number in change['lines']), change['file']
PY_CHECK
"${run[@]}" unit node tools/link-to-fix-checks.mjs verify
printf 'Grouped action gauntlet passed: %s\n' "$artifact"
