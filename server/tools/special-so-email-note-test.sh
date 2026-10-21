#!/usr/bin/env bash
set -Eeuo pipefail

SPECIAL_SO_PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export SPECIAL_SO_PROJECT_ROOT
task_dir="$SPECIAL_SO_PROJECT_ROOT/server/deployments/special-so-email-note-20261009"
evidence_dir="$SPECIAL_SO_PROJECT_ROOT/server/test-artifacts/special-so-email-note-20261009"
mode=${1:-final}
project=mbbs-special-so-note-20261009
compose=(docker compose --project-name "$project" -f "$SPECIAL_SO_PROJECT_ROOT/docker-compose.mbt-test.yml" -f "$task_dir/compose.test.yml")
mkdir -p "$evidence_dir"
cleanup() {
  prior_status=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans > "$evidence_dir/$mode-cleanup.log" 2>&1 || prior_status=1
  docker ps --format '{{.Names}}\t{{.Status}}' > "$evidence_dir/$mode-docker-ps.log"
  docker ps -a --format '{{.Names}}\t{{.Status}}' > "$evidence_dir/$mode-docker-ps-a.log"
  if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]; then
    prior_status=1
  fi
  docker inspect mbbs-operator-app-app-1 mbbs-operator-app-db-1 --format '{{.Name}} {{.State.Health.Status}}' > "$evidence_dir/$mode-production-health.log"
  exit "$prior_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" up -d db > "$evidence_dir/$mode-db.log" 2>&1
"${compose[@]}" run --rm --entrypoint node migrate src/migrate.js > "$evidence_dir/$mode-migrations.log" 2>&1
if [ "$mode" = red ]; then
  set +e
  "${compose[@]}" run --rm --entrypoint /bin/sh test -c 'npm run test:special-stock-request; suite_status=$?; node --test --test-concurrency=1 test/mbt/property/special-so-email-note.property.test.js test/mbt/property/special-order-rejection.property.test.js test/mbt/integration/special-order-rejection-unlock.test.js; property_status=$?; test "$suite_status" -eq 0 && test "$property_status" -eq 0' > "$evidence_dir/red.log" 2>&1
  red_status=$?
  set -e
  printf 'RED exit code: %s\n' "$red_status"
  if [ "$red_status" -eq 0 ]; then exit 1; fi
else
  "${compose[@]}" run --rm --entrypoint bash test tools/special-so-email-note-gauntlet.sh > "$evidence_dir/final.log" 2>&1
fi
