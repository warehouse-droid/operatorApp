#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node --test --test-concurrency=1 \
  test/dispatch/unit/dispatch-command-matrix.test.js \
  test/dispatch/unit/dispatch-performance-contract.test.js \
  test/dispatch/unit/dispatch-repeat-pickup-visits.red.test.js \
  test/dispatch/property/dispatch-performance-command.property.test.js \
  test/dispatch/property/dispatch-repeat-pickup-visits.property.test.js \
  test/dispatch/adversarial/dispatch-repeat-pickup-visits.adversarial.test.js \
  test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js \
  test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js
