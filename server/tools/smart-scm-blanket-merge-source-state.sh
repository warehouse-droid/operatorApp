#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  migrations/146_smart_scm_blanket_load_merge.sql
  public/scm-smart-blanket.js
  public/scm-smart.html
  src/server.js
  src/smart-scm-blanket-repository.js
  src/smart-scm-blanket-ui-harness.js
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/integration/smart-scm-blanket-load-merge.test.js
  test/mbt/integration/smart-scm-blanket-merge-migration.test.js
  test/mbt/property/smart-scm-blanket-merge-selection.property.test.js
  test/support/check-smart-scm-blanket-merge-coverage.mjs
  test/support/run-smart-scm-blanket-merge-mutations.mjs
  tools/smart-scm-blanket-merge-gauntlet.sh
  tools/smart-scm-blanket-merge-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
