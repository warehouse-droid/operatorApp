#!/usr/bin/env bash
set -Eeuo pipefail

so_server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
so_repo_root="$(cd "$so_server_root/.." && pwd)"
so_compose_file="$so_repo_root/docker-compose.mbt-test.yml"
so_project="mbbs-so-reconciliation-db-only-test"
so_compose=(docker compose -p "$so_project" -f "$so_compose_file")
so_source_state="$(
  cd "$so_server_root"
  sha256sum \
    migrations/134_so_reconciliation_db_only.sql \
    src/sales-order-reconciliation.js \
    src/sales-order-reconciliation-repository.js \
    src/sales-order-reconciliation-harness.js \
    src/sales-order-reconciliation-integration-harness.js \
    src/sales-order-reconciliation-mutation-harness.js \
    src/grouped-po-reconciliation-integration-harness.js \
    src/grouped-sales-order-reconciliation-integration-harness.js \
    src/dispatch-group-reconciliation-ui-harness.js \
    src/dispatch-plan-repository.js \
    src/scm-reconciliation.js \
    src/scm-reconciliation-harness.js \
    src/scm-reconciliation-repository.js \
    src/scm-reconciliation-service.js \
    src/scm-reconciliation-so-type-harness.js \
    public/dispatch.js \
    tools/eslint.so-reconciliation.config.js \
    tools/so-reconciliation-db-only-gauntlet.sh \
    | sha256sum \
    | awk '{print $1}'
)"

if [[ ! "$so_source_state" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Could not calculate the SO reconciliation source state." >&2
  exit 70
fi
echo "Grouped reconciliation source state: $so_source_state"

if [[ "$so_project" == "mbbs-operator-app" || "$so_compose_file" == "$so_repo_root/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup_so_gauntlet() {
  "${so_compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup_so_gauntlet EXIT

"${so_compose[@]}" build test
"${so_compose[@]}" up -d --wait db
"${so_compose[@]}" --profile tools run --rm migrate

"${so_compose[@]}" --profile tools run --rm test \
  npx c8 \
    --check-coverage=false \
    --temp-directory /tmp/so-reconciliation-c8 \
    --include src/sales-order-reconciliation.js \
    --reporter text \
    npm run test:so-reconciliation
"${so_compose[@]}" --profile tools run --rm test npm run test:so-reconciliation-integration
"${so_compose[@]}" --profile tools run --rm test npm run test:grouped-po-reconciliation-integration
"${so_compose[@]}" --profile tools run --rm test npm run test:grouped-so-reconciliation-integration
"${so_compose[@]}" --profile tools run --rm test npm run test:dispatch-group-reconciliation-ui
"${so_compose[@]}" --profile tools run --rm test npm run test:scm-reconciliation
"${so_compose[@]}" --profile tools run --rm test npm run test:so-reconciliation-policy
"${so_compose[@]}" --profile tools run --rm test npm run test:scm-reconciliation-so-type
"${so_compose[@]}" --profile tools run --rm test npm run test:scm-reconciliation-repository
"${so_compose[@]}" --profile tools run --rm test npm run test:scm-reconciliation-scope-controls
"${so_compose[@]}" --profile tools run --rm test npm run test:scm-reconciliation-server
"${so_compose[@]}" --profile tools run --rm test npm run test:order-dependencies
"${so_compose[@]}" --profile tools run --rm test npm run test:dispatch-links
"${so_compose[@]}" --profile tools run --rm test npm run test:consolidation
"${so_compose[@]}" --profile tools run --rm test npm run test:dispatch-save-coordination
"${so_compose[@]}" --profile tools run --rm test npm run test:dispatch-load-assignments
"${so_compose[@]}" --profile tools run --rm test npm run mutate:so-reconciliation
"${so_compose[@]}" --profile tools run --rm test \
  node --check src/sales-order-reconciliation.js
"${so_compose[@]}" --profile tools run --rm test \
  node --check src/sales-order-reconciliation-repository.js
"${so_compose[@]}" --profile tools run --rm test \
  node --check src/scm-reconciliation-service.js
"${so_compose[@]}" --profile tools run --rm test \
  node --check src/scm-reconciliation-repository.js
"${so_compose[@]}" --profile tools run --rm test \
  node --check src/dispatch-plan-repository.js
"${so_compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${so_compose[@]}" --profile tools run --rm test npm run typecheck:mbt

set +e
so_full_lint_output="$(
  "${so_compose[@]}" --profile tools run --rm test npm run lint:mbt 2>&1
)"
so_full_lint_status=$?
set -e
if (( so_full_lint_status != 0 )); then
  printf '%s\n' "$so_full_lint_output"
  so_full_lint_files="$(printf '%s\n' "$so_full_lint_output" | sed -n '/^\/app\//p')"
  so_expected_lint_files="$(printf '%s\n' \
    '/app/test/mbt/unit/driver-offline-photo-checkpoint.test.js' \
    '/app/test/mbt/unit/driver-offline-photo-retry-drain.test.js' \
    '/app/test/mbt/unit/driver-offline-terminal-photo-recovery.test.js')"
  if [[ "$so_full_lint_files" != "$so_expected_lint_files" ]] \
    || ! grep -Fq '10 problems (10 errors, 0 warnings)' <<<"$so_full_lint_output"; then
    echo "Repository lint has failures outside the recorded unrelated baseline." >&2
    exit "$so_full_lint_status"
  fi
  echo "Repository lint baseline unchanged: 10 errors in three unrelated offline-photo tests."
fi

"${so_compose[@]}" --profile tools run --rm test \
  npx eslint \
    --config tools/eslint.so-reconciliation.config.js \
    --max-warnings=0 \
    src/sales-order-reconciliation.js \
    src/sales-order-reconciliation-repository.js \
    src/sales-order-reconciliation-harness.js \
    src/sales-order-reconciliation-integration-harness.js \
    src/sales-order-reconciliation-mutation-harness.js \
    src/grouped-po-reconciliation-integration-harness.js \
    src/grouped-sales-order-reconciliation-integration-harness.js \
    src/dispatch-group-reconciliation-ui-harness.js \
    src/dispatch-plan-repository.js \
    src/scm-reconciliation.js \
    src/scm-reconciliation-harness.js \
    src/scm-reconciliation-repository.js \
    src/scm-reconciliation-service.js \
    src/scm-reconciliation-so-type-harness.js

echo "Grouped PO/SO reconciliation gauntlet passed."
