#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

sha256sum \
  migrations/170_transfer_dependency_source_backorder.sql \
  src/transfer-dependency-source-backorder.js \
  src/order-dependency-repository.js \
  src/transfer-dependency-reservation-harness.js \
  public/scm-transfer-dependencies.js \
  public/scm-transfer-dependencies.html \
  public/dispatch.css \
  test/scm-transfer-dependency-workflow.test.js \
  test/mbt/property/transfer-dependency-source-backorder.property.test.js \
  test/support/run-transfer-dependency-source-backorder-mutations.mjs
