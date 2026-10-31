#!/usr/bin/env bash
# Dispatch history replay: restore a fresh production copy into an isolated,
# internal-only database and re-save every retained plan state with the
# baseline ref and with the working tree, then compare them state by state.
# Usage: bash docker/run-dispatch-history-replay.sh [baseline-ref]
# Optional: DISPATCH_HISTORY_CANDIDATE_REF replays that commit instead of the working tree.
# Optional: DISPATCH_HISTORY_FROM / _THROUGH (plan dates), DISPATCH_HISTORY_LIMIT.
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
baseline_ref="${1:-HEAD}"
run_id="mbbs-history-replay-$$"
network="$run_id-net"
volume="$run_id-db"
database="$run_id-db"
art="$MBBS_TEST_ARTIFACT_DIR"
labels=(--label com.mbbs.lifecycle=disposable-test --label "com.mbbs.history-replay=$run_id")
limits=(--init --cgroup-parent=mbbs-tests.slice --memory=2g --memory-swap=2g --pids-limit=512 --cpus=1)
cleanup() {
  result=$?
  trap - EXIT INT TERM
  docker ps -aq --filter "label=com.mbbs.history-replay=$run_id" | xargs -r docker rm -f > /dev/null || result=1
  docker volume rm -f "$volume" > /dev/null 2>&1 || true
  docker network rm "$network" > /dev/null 2>&1 || true
  rm -f -- "$art/source.dump"
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  [[ -z "$(docker ps -aq --filter "label=com.mbbs.history-replay=$run_id")" ]] || result=1
  [[ -z "$(docker volume ls -q --filter "label=com.mbbs.history-replay=$run_id")" ]] || result=1
  [[ -z "$(docker network ls -q --filter "label=com.mbbs.history-replay=$run_id")" ]] || result=1
  curl -fsS --max-time 5 --retry 5 --retry-connrefused -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo_dir"
python3 docker/verify-memory-limits.py
mkdir -m 0700 "$art/baseline" "$art/out"
git archive "$baseline_ref" server | tar -x -C "$art/baseline"
# Freeze the candidate so edits made while a long replay runs cannot mix versions.
# DISPATCH_HISTORY_CANDIDATE_REF replays a commit instead of the shared working tree.
mkdir -p "$art/candidate/server"
if [[ -n "${DISPATCH_HISTORY_CANDIDATE_REF:-}" ]]; then
  git archive "$DISPATCH_HISTORY_CANDIDATE_REF" server | tar -x -C "$art/candidate"
else
  cp -a server/src server/public server/tools server/test server/contracts server/migrations server/package.json \
    "$art/candidate/server/"
fi
candidate="$art/candidate/server"
cp server/tools/dispatch-history-replay-all.mjs server/tools/dispatch-history-replay-compare.mjs \
  server/tools/dispatch-all-history-fixture-classification.mjs "$art/baseline/server/tools/"

docker network create --internal "${labels[@]}" "$network" > /dev/null
docker volume create "${labels[@]}" "$volume" > /dev/null
docker run -d --name "$database" --network "$network" --network-alias db "${labels[@]}" "${limits[@]}" \
  --tmpfs /tmp:rw,size=256m --shm-size=256m -v "$volume:/var/lib/postgresql" \
  -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=history_local_only -e POSTGRES_DB=mbt_test_history \
  postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15 > /dev/null
for attempt in {1..60}; do
  docker exec "$database" pg_isready -U mbt_test -d mbt_test_history > /dev/null 2>&1 && break
  [[ "$attempt" != 60 ]] || { echo "Replay database did not start" >&2; exit 1; }
  sleep 1
done

# The production copy exists only inside this run's private artifact directory
# and is deleted as soon as it is restored.
umask 077
docker exec mbbs-operator-app-db-1 sh -c 'exec pg_dump -Fc --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$art/source.dump"
docker exec -i "$database" pg_restore --exit-on-error --no-owner --no-acl -U mbt_test -d mbt_test_history \
  < "$art/source.dump" > "$art/restore.log" 2>&1 || { tail -20 "$art/restore.log" >&2; exit 1; }
rm -f -- "$art/source.dump"
docker exec "$database" psql -U mbt_test -d mbt_test_history -qc 'ANALYZE'

replay() {
  local tree="$1" name="$2"
  shift 2
  local mounts=()
  for directory in src public tools test contracts migrations; do
    mounts+=(-v "$tree/$directory:/app/$directory:ro")
  done
  mounts+=(-v "$tree/package.json:/app/package.json:ro" -v "$art/out:/app/test-artifacts/history-replay")
  docker run --rm --name "$run_id-$name" --network "$network" "${labels[@]}" "${limits[@]}" \
    --tmpfs /tmp:rw,size=256m --user "$(id -u):$(id -g)" -w /app "${mounts[@]}" \
    -e MBT_TEST_ISOLATED=1 -e NODE_ENV=test -e MBBS_ENV_FILE=.env.history-disabled \
    -e DATABASE_URL=postgres://mbt_test:history_local_only@db:5432/mbt_test_history \
    -e GOOGLE_MAPS_MODE=disabled -e MBT_NETSUITE_WRITES_ENABLED=false -e SMART_SCM_LIVE_EXECUTION_ENABLED=false \
    -e DISPATCH_PLANNER_ORDER_POOL_MODE=on -e DISPATCH_DRIVER_ORIENTED_PLANNING=true \
    -e DISPATCH_HISTORY_LABEL="$name" -e DISPATCH_HISTORY_OUTPUT=test-artifacts/history-replay \
    -e DISPATCH_HISTORY_FROM -e DISPATCH_HISTORY_THROUGH -e DISPATCH_HISTORY_LIMIT -e DISPATCH_HISTORY_DELIVERY_ONLY -e DISPATCH_HISTORY_GROUPED_SPLITS_ONLY \
    mbbs-mbt-p1-test-test:latest "$@"
}
server_result=0
if [[ "${DISPATCH_HISTORY_CLIENT_ONLY:-}" != 1 ]]; then
  replay "$art/baseline/server" baseline node tools/dispatch-history-replay-all.mjs
  replay "$candidate" candidate node tools/dispatch-history-replay-all.mjs
  replay "$candidate" compare node tools/dispatch-history-replay-compare.mjs \
    test-artifacts/history-replay/baseline.ndjson test-artifacts/history-replay/candidate.ndjson \
    test-artifacts/history-replay/compare.json || server_result=$?
fi

# Browser timing replay: the same states through baseline and candidate dispatch.js.
[[ "${DISPATCH_HISTORY_DELIVERY_ONLY:-}" != 1 && "${DISPATCH_HISTORY_SKIP_CLIENT:-}" != 1 ]] || exit "$server_result"
docker run --rm --name "$run_id-client" --network "$network" "${labels[@]}" "${limits[@]}" \
  --tmpfs /tmp:rw,size=512m --shm-size=256m --user "$(id -u):$(id -g)" -w /app \
  -v "$art/baseline/server/public:/baseline-public:ro" -v "$candidate/public:/app/public:ro" \
  -v "$candidate/tools:/app/tools:ro" -v "$art/out:/app/test-artifacts/history-replay" \
  -e MBT_TEST_ISOLATED=1 -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e DATABASE_URL=postgres://mbt_test:history_local_only@db:5432/mbt_test_history \
  -e DISPATCH_HISTORY_FROM -e DISPATCH_HISTORY_THROUGH \
  mbbs-mbt-p1-test-e2e:latest node tools/dispatch-history-client-replay.mjs \
  /baseline-public /app/public test-artifacts/history-replay
exit "$server_result"
