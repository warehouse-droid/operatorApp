#!/usr/bin/env bash
set -Eeuo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_network=mbbs-scm-search-vendor-test
task_db=mbbs-scm-search-vendor-test-db
task_image=mbbs-scm-search-vendor-test:20260910
case "${1:-}" in
  build)
    if ! docker image inspect mbbs-schedule-columns-test:20260910 >/dev/null 2>&1; then
      docker build -f "$task_root/Dockerfile.test" --target test-e2e -t mbbs-schedule-columns-test:20260910 "$task_root"
    fi
    docker build -f "$task_root/test/support/Dockerfile.scm-search-vendor" -t "$task_image" "$task_root"
    ;;
  setup)
    docker network inspect "$task_network" >/dev/null 2>&1 || docker network create --internal "$task_network"
    docker inspect "$task_db" >/dev/null 2>&1 || docker run -d --name "$task_db" --network "$task_network" --network-alias db \
      --tmpfs /var/lib/postgresql -e POSTGRES_DB=mbt_test -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password postgres:18-alpine
    for attempt in {1..40}; do
      if docker exec "$task_db" pg_isready -U mbt_test -d mbt_test >/dev/null; then break; fi
      sleep 1
    done
    bash "$0" run node src/migrate.js
    ;;
  run)
    shift
    mkdir -p "$task_root/test-artifacts/scm-search-vendor"
    chmod a+rwx "$task_root/test-artifacts/scm-search-vendor"
    task_browser_mount=()
    if compgen -G "$task_root/test-artifacts/schedule-columns/browser-cache/chromium-*" >/dev/null; then
      task_browser_mount=(-v "$task_root/test-artifacts/schedule-columns/browser-cache:/ms-playwright:ro")
    fi
    docker run --rm --network "$task_network" --shm-size 256m \
      -v "$task_root/test-artifacts/scm-search-vendor:/app/test-artifacts/scm-search-vendor" \
      "${task_browser_mount[@]}" \
      -v "$task_root/..:/workspace:ro" \
      -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=.env.mbt-test-does-not-exist \
      -e MBBS_REPO_ROOT=/workspace -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
      -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e MBT_NETSUITE_WRITES_ENABLED=false \
      -e MBT_ENABLED=true -e SAMSARA_WRITES_ENABLED=false -e SMART_SCM_LIVE_EXECUTION_ENABLED=false \
      -e DISPATCH_PLANNER_ORDER_POOL_MODE=off -e DISPATCH_PLANNER_COMMAND_MODE=off \
      --entrypoint "${1:-node}" "$task_image" "${@:2}"
    ;;
  *) echo 'Usage: scm-search-vendor-test.sh build|setup|run COMMAND ARGS...' >&2; exit 2 ;;
esac
