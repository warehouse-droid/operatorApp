#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-direct-receipt-gauntlet"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Direct-receipt gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

db_sql() {
  "${compose[@]}" exec -T db \
    psql -X -v ON_ERROR_STOP=1 -U mbt_test -d mbt_test -c "$1"
}

assert_non_unique_receipt_index() {
  db_sql "
    DO \$\$
    DECLARE unique_index boolean;
    BEGIN
      SELECT index.indisunique
        INTO unique_index
        FROM pg_class relation
        JOIN pg_index index ON index.indexrelid = relation.oid
       WHERE relation.relname = 'idx_order_dependencies_direct_receipt_job';
      IF unique_index IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'direct receipt lookup index must exist and be non-unique';
      END IF;
    END
    \$\$;"
}

echo "[direct-receipt] fresh isolated schema"
cleanup
"${compose[@]}" --profile tools build migrate
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate
assert_non_unique_receipt_index

echo "[direct-receipt] pre-data rollback and forward rehearsal"
db_sql "
  DROP INDEX idx_order_dependencies_direct_receipt_job;
  CREATE UNIQUE INDEX idx_order_dependencies_direct_receipt_job
    ON order_dependencies (direct_receipt_job_id)
    WHERE direct_receipt_job_id IS NOT NULL;
  DELETE FROM schema_migrations
    WHERE filename = '189_direct_dependency_shared_driver_receipt.sql';"
"${compose[@]}" --profile tools run --rm migrate
"${compose[@]}" --profile tools run --rm migrate
assert_non_unique_receipt_index

echo "[direct-receipt] multi-TO rollback, completion, and retry contracts"
"${compose[@]}" --profile tools run --rm migrate node src/order-dependency-harness.js

echo "[direct-receipt] mutation: restore the invalid one-job/one-dependency rule"
db_sql "
  DROP INDEX idx_order_dependencies_direct_receipt_job;
  CREATE UNIQUE INDEX idx_order_dependencies_direct_receipt_job
    ON order_dependencies (direct_receipt_job_id)
    WHERE direct_receipt_job_id IS NOT NULL;"
set +e
mutation_output="$("${compose[@]}" --profile tools run --rm migrate node src/order-dependency-harness.js 2>&1)"
mutation_status=$?
set -e
if [[ ${mutation_status} -eq 0 ]]; then
  echo "The unique-index mutant survived the multi-TO regression." >&2
  exit 1
fi
if [[ "${mutation_output}" != *"idx_order_dependencies_direct_receipt_job"* ]]; then
  echo "The unique-index mutant failed for an unrelated reason." >&2
  echo "${mutation_output}" >&2
  exit 1
fi
echo "KILLED 1/1: unique direct_receipt_job_id mutant"
db_sql "
  DROP INDEX idx_order_dependencies_direct_receipt_job;
  CREATE INDEX idx_order_dependencies_direct_receipt_job
    ON order_dependencies (direct_receipt_job_id)
    WHERE direct_receipt_job_id IS NOT NULL;"
assert_non_unique_receipt_index
"${compose[@]}" --profile tools run --rm migrate node src/order-dependency-harness.js

echo "[direct-receipt] syntax, lint, dependency, and secret boundaries"
"${compose[@]}" --profile tools run --rm migrate node --check src/driver-seven-day-replay-harness.js
"${compose[@]}" --profile tools run --rm migrate node --check src/driver-today-pwa-replay-harness.js
"${compose[@]}" --profile tools run --rm migrate \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/driver-seven-day-replay-harness.js \
    src/driver-today-pwa-replay-harness.js
"${compose[@]}" --profile tools run --rm migrate npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm migrate \
  node test/support/scan-diff-secrets.mjs \
    migrations/189_direct_dependency_shared_driver_receipt.sql \
    src/driver-seven-day-replay-harness.js \
    src/driver-today-pwa-replay-harness.js \
    tools/direct-dependency-shared-receipt-gauntlet.sh

echo "[direct-receipt] complete"
