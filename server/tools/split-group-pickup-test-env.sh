#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
network=mbbs-rejected-edit-test
database=mbbs-rejected-edit-test-db
image=mbbs-return-batch-browser-test:20260918
case "${1:-}" in
  start)
    docker network inspect "$network" >/dev/null 2>&1 || docker network create --internal "$network" >/dev/null
    docker run -d --name "$database" --network "$network" --network-alias db \
      -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password -e POSTGRES_DB=mbt_test \
      --tmpfs /var/lib/postgresql postgres:18-alpine >/dev/null
    for attempt in {1..30}; do
      if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then exit 0; fi
      sleep 1
    done
    exit 1
    ;;
  run)
    mode="$2"
    shift 2
    mounts=()
    for folder in src public test tools migrations contracts; do
      folder_root="$server_root/$folder"
      if [[ "$mode" == candidate && ( "$folder" == public || "$folder" == src ) ]]; then
        folder_root=/home/ubuntu/operatorapp-deploy-backups/split-group-pickup-20260924-v1/candidate/"$folder"
      fi
      mounts+=(-v "$folder_root:/app/$folder:ro")
    done
    for file in package.json package-lock.json tsconfig.mbt.json eslint.mbt.config.js Dockerfile Dockerfile.test .c8rc.json; do
      mounts+=(-v "$server_root/$file:/app/$file:ro")
    done
    if [[ "$mode" == mutant ]]; then
      mutant_root="$1"
      shift
      for file in src/server.js src/dispatch-order-catalog-repository.js public/dispatch.js; do
        if [[ -f "$mutant_root/$file" ]]; then mounts+=(-v "$mutant_root/$file:/app/$file:ro"); fi
      done
    elif [[ "$mode" == baseline ]]; then
      mounts+=(-v "$server_root/test-artifacts/split-group-pickup/before/src/server.js:/app/src/server.js:ro")
      mounts+=(-v "$server_root/test-artifacts/split-group-pickup/before/src/dispatch-order-catalog-repository.js:/app/src/dispatch-order-catalog-repository.js:ro")
    elif [[ "$mode" != current && "$mode" != candidate ]]; then
      exit 70
    fi
    docker run --rm --network "$network" --read-only --tmpfs /tmp:mode=1777 \
      --tmpfs /app/data:mode=1777 --tmpfs /app/test-artifacts:mode=1777 \
      -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=.env.rejected-edit-test-does-not-exist \
      -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test_file_120921aabbcc_focus \
      -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app \
      -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e SAMSARA_WRITES_ENABLED=false \
      -e MBT_NETSUITE_WRITES_ENABLED=false -e SMART_SCM_LIVE_EXECUTION_ENABLED=false \
      -e SALES_PUBLIC_ACCESS_ENABLED=false -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      -v "$server_root/..:/workspace:ro" "${mounts[@]}" -w /app --entrypoint "$1" "$image" "${@:2}"
    ;;
  stop)
    docker rm -f "$database" >/dev/null
    docker network rm "$network" >/dev/null
    ;;
  *) echo 'Usage: rejected-edit-test-env.sh start|run baseline/current COMMAND...|stop' >&2; exit 2 ;;
esac
