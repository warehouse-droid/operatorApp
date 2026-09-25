#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
network=${SOR_TEST_NETWORK:-mbbs-sor-rentals-test}
database=mbbs-sor-rentals-test-db
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
      if [[ "$mode" == baseline && "$folder" != tools ]]; then folder_root="$server_root/test-artifacts/sor-rentals/before/$folder"; fi
      if [[ "$mode" == candidate && ( "$folder" == src || "$folder" == public || "$folder" == migrations ) ]]; then folder_root="${SOR_CANDIDATE_ROOT:?Set SOR_CANDIDATE_ROOT}/$folder"; fi
      mounts+=(-v "$folder_root:/app/$folder:ro")
    done
    for file in package.json package-lock.json tsconfig.mbt.json eslint.mbt.config.js Dockerfile Dockerfile.test .c8rc.json; do
      mounts+=(-v "$server_root/$file:/app/$file:ro")
    done
    if [[ -n "${SOR_MUTANT_ROOT:-}" ]]; then
      for file in src/sor-rental-policy.js src/sor-rental-repository.js src/sor-rental-service.js src/sor-signature-evidence.js src/driver-repository.js; do
        if [[ -f "$SOR_MUTANT_ROOT/$file" ]]; then mounts+=(-v "$SOR_MUTANT_ROOT/$file:/app/$file:ro"); fi
      done
    fi
    docker run --rm --network "$network" --read-only --tmpfs /tmp:mode=1777 \
      --tmpfs /app/data:mode=1777 --tmpfs /app/test-artifacts:mode=1777 -v "$server_root/test-artifacts/sor-rentals:/app/test-artifacts/sor-rentals" \
      -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=.env.rejected-edit-test-does-not-exist \
      -e DATABASE_URL=postgres://mbt_test:mbt_test_password@${SOR_TEST_DB_HOST:-db}:5432/${SOR_TEST_DATABASE:-mbt_test} \
      -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app \
      -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e SAMSARA_WRITES_ENABLED=false \
      -e MBT_NETSUITE_WRITES_ENABLED=false -e SMART_SCM_LIVE_EXECUTION_ENABLED=false \
      -e SALES_PUBLIC_ACCESS_ENABLED=false -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      -v "$server_root/test-artifacts/sor-rentals/browsers:/ms-playwright:ro" \
      -v "$server_root/test-artifacts/sor-rentals/node_modules:/app/node_modules:ro" \
      -v "$server_root/..:/workspace:ro" "${mounts[@]}" -w /app --entrypoint "$1" "$image" "${@:2}"
    ;;
  stop)
    docker rm -f "$database" >/dev/null
    docker network rm "$network" >/dev/null
    ;;
  *) echo 'Usage: sor-rentals-test-env.sh start|run baseline/current/candidate COMMAND...|stop' >&2; exit 2 ;;
esac
