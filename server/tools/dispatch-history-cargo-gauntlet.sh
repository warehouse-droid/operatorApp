#!/usr/bin/env bash
set -Eeuo pipefail
cargo_server="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$cargo_server/.."
cargo_original="$cargo_server/test-artifacts/dispatch-all-history-20261002"
cargo_artifact="$cargo_original/cargo-route"
cargo_environment="$cargo_server/tools/dispatch-all-history-environment.sh"
test -s "$cargo_original/source.dump"
test -d "$cargo_original/final-source/src"
test -d "$cargo_artifact/final-source/src"
sudo -n docker network inspect mbbs-order-history-20261002 --format '{{.Internal}}' | rg '^true$'

# Retain evidence before producing a fresh run. Never copy or modify production.
cargo_backup="$cargo_artifact/previous-evidence/$(date -u +%Y%m%dT%H%M%S)-$$"
mkdir -p "$cargo_backup"
shopt -s nullglob
for cargo_file in "$cargo_artifact"/*.json "$cargo_artifact"/*.log "$cargo_artifact"/*.md "$cargo_artifact"/*.patch; do
  cp -a "$cargo_file" "$cargo_backup/"
done
for cargo_directory in save-replays coverage; do
  if [[ -d "$cargo_artifact/$cargo_directory" ]]; then cp -a "$cargo_artifact/$cargo_directory" "$cargo_backup/"; fi
done

# The comparison uses the complete, previously frozen source and old fixtures.
export DISPATCH_ALL_HISTORY_IMAGE=mbbs-regular-v2:e2e
export DISPATCH_ALL_HISTORY_SOURCE_ROOT="$cargo_original/final-source"
bash "$cargo_environment" candidate-exec node tools/dispatch-all-history-bounded-command.mjs npm test > "$cargo_artifact/full-baseline.log" 2>&1 || true
bash "$cargo_environment" candidate-exec node tools/dispatch-all-history-bounded-command.mjs node test/support/run-dispatch-performance-tests.mjs unit property adversarial frontend integration concurrency > "$cargo_artifact/dispatch-baseline.log" 2>&1 || true
bash "$cargo_environment" candidate-exec npm run typecheck:mbt > "$cargo_artifact/types-baseline.log" 2>&1 || true

export DISPATCH_ALL_HISTORY_SOURCE_ROOT="$cargo_artifact/final-source"
export DISPATCH_ALL_HISTORY_BASELINE_ROOT="$cargo_original/final-source"
bash "$cargo_environment" candidate-exec node tools/dispatch-all-history-bounded-command.mjs npm test > "$cargo_artifact/full-candidate.log" 2>&1 || true
bash "$cargo_environment" candidate-exec node tools/dispatch-all-history-bounded-command.mjs node test/support/run-dispatch-performance-tests.mjs unit property adversarial frontend integration concurrency > "$cargo_artifact/dispatch-candidate.log" 2>&1 || true
bash "$cargo_environment" candidate-exec npm run typecheck:mbt > "$cargo_artifact/types-candidate.log" 2>&1 || true
for cargo_kind in baseline candidate; do
  cargo_files=(src/driver-repository.js src/dispatch-load-assignment.js public/dispatch.js)
  if [[ "$cargo_kind" = candidate ]]; then
    cargo_files+=(src/dispatch-retained-link-manifests.js test/dispatch/unit/linked-stop-cargo.test.js test/dispatch/integration/linked-driver-stop-content.test.js 'tools/dispatch-history-cargo-*.mjs')
  fi
  bash "$cargo_environment" "$cargo_kind-exec" ./node_modules/.bin/eslint --config tools/dispatch-history-cargo-eslint.config.mjs --format json "${cargo_files[@]}" > "$cargo_artifact/lint-$cargo_kind.json" 2> "$cargo_artifact/lint-$cargo_kind.log" || true
done
bash "$cargo_environment" candidate-exec ./node_modules/.bin/eslint --config tools/dispatch-history-cargo-eslint.config.mjs --rule 'complexity:[error,12]' --max-warnings=0 src/dispatch-retained-link-manifests.js > "$cargo_artifact/complexity.log" 2>&1
DISPATCH_ALL_HISTORY_DATABASE=mbt_history_focus bash "$cargo_environment" candidate-exec node tools/dispatch-history-cargo-mutations.mjs > "$cargo_artifact/mutations.log" 2>&1
bash "$cargo_environment" candidate-exec node node_modules/c8/bin/c8.js --all=false --check-coverage=false --include=src/driver-repository.js --include=src/dispatch-retained-link-manifests.js --include=src/dispatch-load-assignment.js --include=public/dispatch.js --reporter=json --reporter=text --reports-dir=test-artifacts/dispatch-all-history-20261002/cargo-route/coverage --temp-directory=test-artifacts/dispatch-all-history-20261002/cargo-route/coverage-final-tmp node tools/dispatch-history-cargo-focused.mjs > "$cargo_artifact/focused-final.log" 2>&1
bash "$cargo_environment" candidate-exec node tools/dispatch-history-cargo-focused.mjs --shuffle > "$cargo_artifact/shuffle.log" 2>&1

python3 - "$cargo_original" "$cargo_artifact" <<'PY'
import difflib,pathlib,sys
original,root=map(pathlib.Path,sys.argv[1:])
chunks=[]
for file in ['src/driver-repository.js','src/dispatch-retained-link-manifests.js','src/dispatch-load-assignment.js','public/dispatch.js']:
    old=original/'final-source'/file
    before=old.read_text().splitlines(keepends=True) if old.exists() else []
    after=(root/'final-source'/file).read_text().splitlines(keepends=True)
    chunks.append(''.join(difflib.unified_diff(before,after,fromfile='a/'+file,tofile='b/'+file,n=0)))
(root/'changes.patch').write_text(''.join(chunks))
PY
bash "$cargo_environment" candidate-exec node tools/dispatch-history-cargo-secrets.mjs > "$cargo_artifact/secrets.log" 2>&1

for cargo_pass in 1 2; do
  bash "$cargo_environment" reset
  bash "$cargo_environment" history-exec env DISPATCH_HISTORY_REPORT_DIRECTORY=test-artifacts/dispatch-all-history-20261002/cargo-route/save-replays node tools/dispatch-all-history-replay.mjs "$cargo_pass" > "$cargo_artifact/save-pass-$cargo_pass.log" 2>&1
  bash "$cargo_environment" history-exec node tools/dispatch-history-cargo-replay.mjs "$cargo_pass" > "$cargo_artifact/cargo-pass-$cargo_pass.log" 2>&1
done
python3 "$cargo_server/tools/dispatch-history-cargo-evidence.py"
