#!/usr/bin/env bash
set -Eeuo pipefail
cd /home/ubuntu/apps/operatorApp
root="$PWD/server"
evidence="$root/artifacts/receipt-extra-charges-20261019"
release="$root/deployments/receipt-extra-charges-20261019"
name=mbbs-receipt-extra-charges-quality
cleanup() {
  docker rm -fv "$name" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$evidence/quality-containers-running.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$evidence/quality-containers-all.txt"
}
trap cleanup EXIT INT TERM
python3 - "$release" "$evidence" <<'PY'
import difflib,json,sys
from pathlib import Path
release,evidence=map(Path,sys.argv[1:])
manifest=json.loads((release/'manifest.json').read_text())
changes={}
for file in manifest['files']:
 before=release/'before'/file
 old=before.read_text().splitlines() if before.exists() else []
 new=(release/'candidate'/file).read_text().splitlines()
 changes[file]=[i+1 for op,a,b,c,d in difflib.SequenceMatcher(None,old,new).get_opcodes()
  if op in ['replace','insert'] for i in range(c,d)]
(evidence/'changed-lines.json').write_text(json.dumps(changes))
PY
image=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["app"]["imageId"])' "$release/capture.json")
docker run --rm --init --name "$name" --network none --read-only \
  --label com.mbbs.lifecycle=disposable-test --cgroup-parent=mbbs-tests.slice \
  --memory=2g --memory-swap=2g --cpus=1 --pids-limit=256 \
  --tmpfs /tmp:uid=1000,gid=1000,mode=1777,size=256m \
  --tmpfs /app/data:uid=1000,gid=1000,mode=0700,size=16m \
  --env NODE_ENV=test --env NETSUITE_DIRECT_ACCESS_ENABLED=false --env NETSUITE_MIRROR_ROLE=disabled \
  --env MBBS_ENV_FILE=/nonexistent \
  -v "$release/candidate/src:/app/src:ro" -v "$release/before/src:/baseline/src:ro" \
  -v "$release/candidate/public:/app/public:ro" -v "$release/before/public:/baseline/public:ro" \
  -v "$release/before/package.json:/baseline/package.json:ro" \
  -v "$root/tools/receipt-extra-charges:/app/tools/receipt-extra-charges:ro" \
  -v "$root/test-artifacts/operator-to-yard-flow-tooling/node_modules:/app/node_modules:ro" \
  -v "$root/test-artifacts/operator-to-yard-flow-tooling/node_modules:/baseline/node_modules:ro" \
  -v "$root/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro" \
  -v "$evidence:/evidence" --entrypoint node "$image" tools/receipt-extra-charges/quality.mjs \
  > "$evidence/quality.log" 2>&1
tail -12 "$evidence/quality.log"
