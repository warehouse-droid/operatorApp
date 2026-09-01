#!/usr/bin/env bash
set -Eeuo pipefail

project="mbbs-webhook-50-stress"
compose_file="docker-compose.mbt-test.yml"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact_dir="${repo_root}/server/test-artifacts/netsuite-webhook-concurrency"
stats_pid=""

if [[ "${project}" != "mbbs-webhook-50-stress" ]]; then
  echo "Refusing to run against an unexpected Compose project." >&2
  exit 70
fi

cd "${repo_root}"
compose=(docker compose --project-name "${project}" --file "${compose_file}" --profile tools --profile runtime --profile webhook-stress)

stop_stats() {
  if [[ -n "${stats_pid}" ]]; then
    kill "${stats_pid}" 2>/dev/null || true
    wait "${stats_pid}" 2>/dev/null || true
    stats_pid=""
  fi
}

cleanup() {
  stop_stats
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

start_stats() {
  local phase="$1"
  shift
  : > "${artifact_dir}/${phase}-docker-stats.ndjson"
  while true; do
    docker stats --no-stream --format '{{json .}}' "$@"
    sleep 0.1
  done > "${artifact_dir}/${phase}-docker-stats.ndjson" &
  stats_pid="$!"
}

mkdir -p "${artifact_dir}"
"${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true

echo "[webhook-50] building isolated application and test images"
"${compose[@]}" build app test webhook-worker

echo "[webhook-50] starting fresh PostgreSQL and applying migrations"
"${compose[@]}" up --detach db
"${compose[@]}" run --rm migrate

echo "[webhook-50] proving the test-only runtime contract is green"
"${compose[@]}" run --rm --no-deps test node --test test/workload/unit/runtime-resource-limits.contract.test.js

echo "[webhook-50] starting disposable application"
"${compose[@]}" up --detach --no-deps app
for _ in $(seq 1 30); do
  app_id="$("${compose[@]}" ps --quiet app)"
  if [[ -n "${app_id}" ]] && [[ "$(docker inspect --format '{{.State.Health.Status}}' "${app_id}")" == "healthy" ]]; then
    break
  fi
  sleep 2
done
app_id="$("${compose[@]}" ps --quiet app)"
db_id="$("${compose[@]}" ps --quiet db)"
if [[ -z "${app_id}" || -z "${db_id}" ]] || [[ "$(docker inspect --format '{{.State.Health.Status}}' "${app_id}")" != "healthy" ]]; then
  echo "Disposable application did not become healthy." >&2
  "${compose[@]}" logs --no-color app db >&2
  exit 1
fi

echo "[webhook-50] releasing 50 simultaneous HTTP requests"
start_stats ingress "${app_id}" "${db_id}"
"${compose[@]}" run --rm --no-deps test node tools/netsuite-webhook-concurrency-stress.mjs ingress
stop_stats

echo "[webhook-50] starting four competing serial workers behind the queue barrier"
"${compose[@]}" up --detach --no-deps --scale webhook-worker=4 webhook-worker
mapfile -t worker_ids < <("${compose[@]}" ps --quiet webhook-worker)
if [[ "${#worker_ids[@]}" -ne 4 ]]; then
  echo "Expected four disposable worker containers; found ${#worker_ids[@]}." >&2
  exit 1
fi

start_stats drain "${app_id}" "${db_id}" "${worker_ids[@]}"
"${compose[@]}" run --rm --no-deps test node tools/netsuite-webhook-concurrency-stress.mjs verify
stop_stats

"${compose[@]}" logs --no-color app webhook-worker > "${artifact_dir}/container.log"
"${compose[@]}" ps --format json > "${artifact_dir}/stack.json"
"${compose[@]}" run --rm --no-deps test node tools/netsuite-webhook-concurrency-stress.mjs resources

echo "[webhook-50] complete"
echo "Ingress: ${artifact_dir}/run.json"
echo "Drain:   ${artifact_dir}/result.json"
echo "CPU/RAM: ${artifact_dir}/resources.json"
