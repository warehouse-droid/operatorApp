#!/usr/bin/env bash
# Replay the verified private capture without repeatedly transmitting its raw
# JSON over individual SQL queries. The application still checks every state.
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_root"
private=server/test-artifacts/dispatch-save-reliability/private-history
report="${1:-replay-final-report.json}"
[[ "$report" != */* && "$report" == *.json ]]
test -s "$private/staged-input.dump"
test -s "$private/staged-input.json"
rm -f "$private/$report.ready" "$private/$report.loaded"
bash server/tools/dispatch-save-reliability-test.sh node tools/dispatch-save-history-replay.mjs \
  test-artifacts/dispatch-save-reliability/private-history "$report" --staged "${@:2}" &
runner_pid=$!
for attempt in {1..300}; do
  if test -s "$private/$report.ready"; then break; fi
  kill -0 "$runner_pid" || { wait "$runner_pid"; exit 1; }
  sleep 1
done
test -s "$private/$report.ready"
container="$(cat "$private/$report.ready")"
network="$(docker inspect --format '{{range $name, $value := .NetworkSettings.Networks}}{{$name}}{{end}}' "$container")"
[[ "$network" == mbbs-dispatch-save-reliability-* ]]
docker exec -i "$network-db" pg_restore --exit-on-error --data-only -U mbt_test -d mbt_test < "$private/staged-input.dump"
touch "$private/$report.loaded"
wait "$runner_pid"
