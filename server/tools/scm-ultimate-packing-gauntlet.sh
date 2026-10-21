#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact="$server_root/test-artifacts/scm-ultimate-packing-20261005"
python3 tools/scm-ultimate-packing-source.py
if [[ -d "$artifact/final" ]]; then
  mv "$artifact/final" "$artifact/previous-final-$(date +%s)"
fi
mkdir -p "$artifact/final"
python3 tools/scm-ultimate-packing-review.py > "$artifact/final/review.log"
SCM_PACKING_SOURCE_ROOT="$artifact/baseline" bash tools/scm-ultimate-packing-test.sh \
  node tools/scm-ultimate-packing-suites.mjs baseline > "$artifact/final/baseline.log" 2>&1
cp "$artifact/baseline-suites/summary.json" "$artifact/final/baseline-summary.json"
bash tools/scm-ultimate-packing-test.sh node tools/scm-ultimate-packing-final.mjs > "$artifact/final/gauntlet.log" 2>&1
python3 - "$artifact" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
artifact = Path(sys.argv[1])
server = artifact.parents[1]
manifest = json.loads((artifact / "source-manifest.json").read_text())
assert all(hashlib.sha256((server / file).read_bytes()).hexdigest() == value
           for file, value in manifest['sourceHashes'].items()), 'Source changed during verification'
assert hashlib.sha256((artifact / 'replay-input.json').read_bytes()).hexdigest() == manifest['fixtureHash']
(artifact / 'final/source-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps({'completed': True, 'sourceTreeHash': manifest['sourceTreeHash']}))
PY
