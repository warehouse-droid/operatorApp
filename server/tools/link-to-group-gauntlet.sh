#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact="$server_root/test-artifacts/link-to-group"
mkdir -p "$artifact"
baseline="${LINK_TO_GROUP_BASELINE:-$(mktemp -d /tmp/link-to-group-baseline.XXXXXX)}"
if [[ ! -f "$baseline/package.json" ]]; then
  python3 - "$server_root" "$baseline" <<'PY'
from pathlib import Path
import shutil, subprocess, sys
source, target = map(Path, sys.argv[1:])
for name in ['src', 'public', 'test', 'tools', 'migrations', 'contracts']:
    shutil.copytree(source / name, target / name, dirs_exist_ok=True)
for path in source.iterdir():
    if path.is_file() and (path.suffix in ['.json', '.js'] or path.name.startswith('Dockerfile')):
        shutil.copy2(path, target / path.name)
for name in ['test/mbt/unit/link-to-group.test.js', 'test/mbt/integration/link-to-group.test.js',
             'test/mbt/integration/link-to-group-http.test.js']:
    (target / name).unlink()
subprocess.run(['git', 'apply', '--reverse', str(source / 'test/support/link-to-group-changes.patch')], cwd=target, check=True)
PY
fi
if [[ ! -L "$baseline/node_modules" ]]; then ln -s /app/node_modules "$baseline/node_modules"; fi
export LINK_TO_GROUP_BASELINE="$baseline"
runner=(bash "$server_root/tools/link-to-group-test.sh")
set +e
LINK_TO_GROUP_SOURCE_ROOT="$baseline" "${runner[@]}" npm test > "$artifact/baseline-current-full.log" 2>&1
baseline_status=$?
set -e
if [[ "$baseline_status" -gt 1 ]]; then exit "$baseline_status"; fi
"${runner[@]}" node tools/link-to-group-checks.mjs static > "$artifact/static.log" 2>&1
if [[ -d "$artifact/coverage" ]]; then rm -rf "$artifact/coverage"; fi
"${runner[@]}" node tools/link-to-group-checks.mjs packet > "$artifact/packet-final.log" 2>&1
"${runner[@]}" node tools/link-to-group-checks.mjs coverage > "$artifact/coverage.log" 2>&1
"${runner[@]}" node tools/link-to-group-checks.mjs mutations > "$artifact/mutations.log" 2>&1
"${runner[@]}" node tools/link-to-group-checks.mjs shuffle > "$artifact/shuffle.log" 2>&1
set +e
"${runner[@]}" npm test > "$artifact/full-final.log" 2>&1
full_status=$?
set -e
if [[ "$full_status" -gt 1 ]]; then exit "$full_status"; fi
"${runner[@]}" node tools/link-to-group-checks.mjs compare
"${runner[@]}" node tools/link-to-group-checks.mjs source
printf 'Link TO verification passed; evidence: %s\n' "$artifact"
