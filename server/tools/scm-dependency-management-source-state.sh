#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  .env.example
  package.json
  package-lock.json
  migrations/173_scm_dependency_management.sql
  public/dispatch.js
  public/driver.html
  public/driver.js
  public/driver-service-worker.js
  public/scm-dependency-management.html
  public/scm-dependency-management.js
  src/driver-offline-repository.js
  src/driver-offline-service.js
  src/driver-route-change-service.js
  src/driver-route-push.js
  src/order-dependency-repository.js
  src/scm-dependency-command-service.js
  src/scm-dependency-management-policy.js
  src/scm-dependency-management-repository.js
  src/scm-dependency-plan-reconciler.js
  src/scm-dependency-preview-service.js
  src/scm-dependency-search-repository.js
  src/server.js
  test/scm-dependency-management-spec.md
  test/support/run-scm-dependency-management-mutations.mjs
  tools/scm-dependency-management-gauntlet.sh
  tools/scm-dependency-management-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid SCM dependency source-state input: ${file}" >&2
    exit 66
  fi
done

if ! node -e 'const p=require("./package.json"); if(p.dependencies?.["web-push"]!=="3.6.7") process.exit(1)'; then
  echo "web-push must remain exactly pinned to 3.6.7." >&2
  exit 65
fi
if grep -Eiq '(^|[[:space:]])(DROP|TRUNCATE)[[:space:]]' migrations/173_scm_dependency_management.sql; then
  echo "SCM dependency migration must remain additive." >&2
  exit 65
fi
if grep -Eiq 'VAPID_PRIVATE|privateKey|customer|address|orderRef|orderNumber' public/driver-service-worker.js; then
  echo "Driver route notification worker contains forbidden secret or operational detail fields." >&2
  exit 65
fi
if grep -Eiq 'auto(matically)?(Apply|Acknowledge)RouteChange' public/driver.js public/scm-dependency-management.js; then
  echo "SCM dependency route changes must never auto-acknowledge or auto-apply." >&2
  exit 65
fi

for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
