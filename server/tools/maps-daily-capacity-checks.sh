#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
network=mbbs-maps-daily-capacity-test
database=mbbs-maps-daily-capacity-db
image=field-sales-check-2941306:latest
docker=(sudo -n docker)
run=("${docker[@]}" run --rm --network "$network" --read-only
  --tmpfs /tmp:mode=1777 --tmpfs /app/data:uid=1000,gid=1000,mode=0700
  -v "$server_root/src:/app/src:ro" -v "$server_root/public:/app/public:ro"
  -v "$server_root/test:/app/test:ro" -v "$server_root/tools:/app/tools:ro"
  -v "$server_root/migrations:/app/migrations:ro" -v "$server_root/package.json:/app/package.json:ro"
  -v "$server_root/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro"
  -v "$server_root/test-artifacts/maps-daily-capacity:/app/test-artifacts/maps-daily-capacity"
  -w /app -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=.env.maps-daily-test-missing
  -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test
  -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e SMART_SCM_LIVE_EXECUTION_ENABLED=false
  -e NETSUITE_MIRROR_ROLE=disabled -e GOOGLE_MAPS_API_KEY= -e GOOGLE_MAPS_SERVER_API_KEY=
  -e GOOGLE_MAPS_BROWSER_API_KEY= -e SALES_PUBLIC_ACCESS_ENABLED=false
  -e OLLAMA_BASE_URL=http://127.0.0.1:9 --entrypoint node "$image")
mkdir -p "$server_root/test-artifacts/maps-daily-capacity"

case "${1:-test}" in
  setup)
    if ! "${docker[@]}" network inspect "$network" >/dev/null 2>&1; then
      "${docker[@]}" network create --internal "$network"
    fi
    if ! "${docker[@]}" inspect "$database" >/dev/null 2>&1; then
      "${docker[@]}" run -d --name "$database" --network "$network" --network-alias db \
        --tmpfs /var/lib/postgresql -e POSTGRES_DB=mbt_test -e POSTGRES_USER=mbt_test \
        -e POSTGRES_PASSWORD=mbt_test_password postgres:18-alpine
    fi
    for _ in {1..30}; do
      if "${docker[@]}" exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null; then break; fi
      sleep 1
    done
    "${run[@]}" src/migrate.js
    ;;
  test)
    "${run[@]}" --test --test-concurrency=1 \
      test/mbt/unit/google-maps-usage-policy.red.test.js \
      test/mbt/property/google-maps-usage-policy.property.test.js \
      test/mbt/unit/google-maps-gateway.red.test.js \
      test/dispatch/frontend/google-maps-usage-control.contract.test.js \
      test/dispatch/adversarial/google-maps-usage-replay.test.js \
      test/mbt/concurrency/google-maps-usage-budget.concurrency.test.js \
      test/mbt/unit/frontdesk-pricing-adapter.test.js \
      test/mbt/unit/google-maps-daily-capacity.test.js \
      test/mbt/integration/google-maps-daily-capacity.test.js \
      test/mbt/integration/google-maps-daily-http.test.js \
      test/dispatch/frontend/google-maps-daily-capacity.test.js
    ;;
  run)
    shift
    "${run[@]}" "$@"
    ;;
  *) echo "Usage: $0 setup|test|run [node arguments]" >&2; exit 2 ;;
esac
