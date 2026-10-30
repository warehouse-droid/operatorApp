#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
test_project="mbbs-source-save-$$"
compose=(docker compose -p "$test_project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$MBBS_TEST_ARTIFACT_DIR/compose.json")
finish() {
  result=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans || result=1
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  for kind in container volume network; do
    flags=(-q)
    if [[ "$kind" == container ]]; then flags+=(-a); fi
    if [[ -n "$(docker "$kind" ls "${flags[@]}" --filter "label=com.docker.compose.project=$test_project")" ]]; then result=1; fi
  done
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo_dir"
python3 docker/verify-memory-limits.py
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
python3 - "$repo_dir" "$MBBS_TEST_ARTIFACT_DIR" <<'PY'
import json, os, sys
from pathlib import Path
repo, artifact = map(Path, sys.argv[1:])
runtime = Path(os.environ.get('DISPATCH_SOURCE_RUNTIME', str(repo / 'server')))
mounts = [{'type': 'bind', 'source': str((runtime if name in ('src', 'public') else repo / 'server') / name),
           'target': '/app/' + name, 'read_only': True} for name in ('src', 'public', 'test', 'tools')]
mounts.append({'type': 'bind', 'source': str(artifact), 'target': '/app/test-artifacts'})
if os.environ.get('DISPATCH_SOURCE_MIGRATIONS'):
    mounts.append({'type':'bind','source':os.environ['DISPATCH_SOURCE_MIGRATIONS'],'target':'/app/migrations','read_only':True})
baseline = Path(os.environ.get('DISPATCH_SOURCE_BASELINE', str(repo / 'server/deployments/dispatch-source-save-20261022/before-workspace')))
if 'DISPATCH_SOURCE_RUNTIME' in os.environ and (runtime.parent / 'live-before').exists():
    baseline = runtime.parent / 'live-before'
if baseline.exists():
    mounts.append({'type': 'bind', 'source': str(baseline), 'target': '/baseline-source', 'read_only': True})
service = {'image': 'mbbs-dispatch-source-test:latest', 'build': {'target': 'test-e2e'}, 'volumes': mounts,
           'labels': {'com.mbbs.lifecycle': 'disposable-test'},
           'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright'}}
(artifact / 'compose.json').write_text(json.dumps({'services': {'test': service, 'migrate': service,
    'db': {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}}}))
PY
if [[ "${DISPATCH_SOURCE_SKIP_BUILD:-0}" != 1 ]]; then
  "${compose[@]}" build test > "$MBBS_TEST_ARTIFACT_DIR/build.log" 2>&1 || { tail -60 "$MBBS_TEST_ARTIFACT_DIR/build.log"; exit 1; }
fi
if [[ "${DISPATCH_SOURCE_NO_DB:-0}" != 1 ]]; then
  "${compose[@]}" up -d --wait db
  "${compose[@]}" run --rm --no-deps -T migrate > "$MBBS_TEST_ARTIFACT_DIR/migrate.log" 2>&1 || { tail -60 "$MBBS_TEST_ARTIFACT_DIR/migrate.log"; exit 1; }
fi
"${compose[@]}" run --rm --no-deps -T test "$@"
