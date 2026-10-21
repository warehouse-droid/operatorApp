#!/usr/bin/env bash
set -euo pipefail
remaining_repo=$(cd "$(dirname "$0")/../.." && pwd)
remaining_phase=${1:?phase required}
remaining_command=${2:?container command required}
remaining_source=${REMAINING_SOURCE:-"$remaining_repo/server"}
remaining_artifacts="$remaining_repo/server/test-artifacts/regular-stock-remaining-20261016"
remaining_project="mbbs-remaining-$$"
remaining_override="$remaining_artifacts/compose-$$.json"
mkdir -p "$remaining_artifacts/$remaining_phase"
chown 1000:1000 "$remaining_artifacts/$remaining_phase"
remaining_compose=(docker compose -p "$remaining_project" -f "$remaining_repo/docker-compose.mbt-test.yml" -f "$remaining_override")
cleanup_remaining() {
  "${remaining_compose[@]}" down --volumes --remove-orphans > "$remaining_artifacts/$remaining_phase/teardown.log" 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$remaining_artifacts/$remaining_phase/docker-ps.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$remaining_artifacts/$remaining_phase/docker-ps-a.txt"
  docker inspect --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$remaining_artifacts/$remaining_phase/production-health.txt"
  test -z "$(docker ps -aq --filter "label=com.docker.compose.project=$remaining_project")"
  rm -f "$remaining_override"
}
trap cleanup_remaining EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$remaining_repo" "$remaining_source" "$remaining_artifacts" "$remaining_override" <<'PY'
import json,sys
repo,source,artifacts,override=sys.argv[1:]
mounts=[f'{source}/{name}:/app/{name}:ro' for name in ['src','public','test','contracts','migrations','package.json']]
mounts += [f'{repo}/server/tools:/app/tools:ro', f'{repo}/server/test-artifacts/driver-upload-reliability/toolchain/node_modules:/app/node_modules:ro', f'{artifacts}:/app/test-artifacts']
service={'image':'mbbs-to-yard-test-browser:20261009','pull_policy':'never','working_dir':'/app','user':'1000:1000','environment':{'XDG_CONFIG_HOME':'/tmp/remaining-config','XDG_CACHE_HOME':'/tmp/remaining-cache'},'labels':{'com.mbbs.lifecycle':'disposable-test'},'volumes':mounts}
json.dump({'services':{'test':service,'migrate':service,'db':{'labels':{'com.mbbs.lifecycle':'disposable-test'}}}},open(override,'w'))
PY
remaining_run_options=()
if [[ "${REMAINING_NO_DB:-0}" == 1 ]]; then
  remaining_run_options+=(--no-deps)
else
  "${remaining_compose[@]}" run --rm migrate > "$remaining_artifacts/$remaining_phase/migrate.log" 2>&1 || { tail -60 "$remaining_artifacts/$remaining_phase/migrate.log"; exit 1; }
fi
"${remaining_compose[@]}" run --rm "${remaining_run_options[@]}" test sh -c "$remaining_command" > "$remaining_artifacts/$remaining_phase/checks.log" 2>&1 || { tail -100 "$remaining_artifacts/$remaining_phase/checks.log"; exit 1; }
tail -15 "$remaining_artifacts/$remaining_phase/checks.log"
