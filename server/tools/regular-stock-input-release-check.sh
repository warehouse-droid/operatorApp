#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
release="$PWD/server/deployments/regular-stock-input-20261020"
test -f "$release/manifest.json"
rm -f "$release/validation-cleanup-passed"
mkdir -p "$release/validation-artifacts/regular-stock-input-20261020"
cp -a server/test-artifacts/regular-stock-input-20261020/before "$release/validation-artifacts/regular-stock-input-20261020/"
chown -R 1000:1000 "$release/validation-artifacts"
python3 - "$release" <<'PY'
import json
from pathlib import Path
import shutil
import sys
release=Path(sys.argv[1])
baseline=release/'validation-artifacts/regular-stock-input-20261020/before'
for name in json.loads((release/'manifest.json').read_text())['files']:
    original=release/'before'/name
    if original.exists():
        shutil.copy2(original,baseline/name)
services={}
for service in ['test','migrate']:
    mounts=[f'{release}/candidate/{name}:/app/{name}:ro' for name in ['src','migrations','package.json','package-lock.json']]
    if service=='test':
        mounts += [f'{release}/candidate/public:/app/public:ro',f'{release}/validation-artifacts:/app/test-artifacts']
    services[service]={'volumes':mounts}
(release/'compose.validation.json').write_text(json.dumps({'services':services},indent=2)+'\n')
PY
REGULAR_INPUT_OVERLAY="$release/compose.validation.json" \
REGULAR_INPUT_SOURCE="$release/candidate" \
REGULAR_INPUT_OUTPUT="$release/validation-artifacts/regular-stock-input-20261020" \
REGULAR_INPUT_CLEANUP_MARKER="$release/validation-cleanup-passed" \
bash server/tools/regular-stock-input-check.sh full
