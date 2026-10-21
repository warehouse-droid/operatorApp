#!/usr/bin/env bash
# Reattach to the disposable run if its launching terminal disconnects.
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$repo_root/server/test-artifacts/dispatch-refresh-targets-20261019"
project=mbbs-dispatch-refresh-targets-test
container="${1:?Exact running test container required}"
compose=(docker compose --project-directory "$repo_root" -p "$project"
  -f "$repo_root/docker-compose.mbt-test.yml" -f "$artifact/compose.json")
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")" == "$project" ]]
[[ "$(docker inspect --format '{{index .Config.Labels "com.mbbs.lifecycle"}}' "$container")" == disposable-test ]]
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans > "$artifact/teardown.log" 2>&1 || status=1
  docker ps --format '{{.Names}} {{.Status}}' > "$artifact/docker-ps.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$artifact/docker-ps-a.log"
  [[ -z "$(docker ps -a --filter "label=com.docker.compose.project=$project" -q)" ]] || status=1
  [[ -z "$(docker volume ls --filter "label=com.docker.compose.project=$project" -q)" ]] || status=1
  [[ -z "$(docker network ls --filter "label=com.docker.compose.project=$project" -q)" ]] || status=1
  docker exec mbbs-operator-app-app-1 node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1))" >/dev/null || status=1
  printf 'teardown_exit=%s\n' "$status" >> "$artifact/teardown.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker logs --follow "$container" > "$artifact/recovered-validation.log" 2>&1 &
log_pid=$!
result="$(docker wait "$container")"
wait "$log_pid" || true
printf 'container_exit=%s\n' "$result" > "$artifact/container-exit.log"
exit "$result"
