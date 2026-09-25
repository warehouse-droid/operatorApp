#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_root"
artifact=server/test-artifacts/local-load-performance
mkdir -p "$artifact/baseline/src"
rm -f "$artifact"/{baseline,suite,static,coverage,mutations}.json
rm -rf "$artifact/c8-tmp" "$artifact/coverage"
cp server/src/delivery-repository.js "$artifact/baseline/src/"
patch --batch -p1 -d "$artifact/baseline" < server/test/support/local-load-performance-baseline.patch
if LOCAL_LOAD_PERF_BASELINE=1 bash server/tools/local-load-performance-test.sh node --test test/mbt/integration/local-load-performance.test.js > "$artifact/red.log" 2>&1; then
  echo 'Expected the baseline workload regressions to fail' >&2
  exit 1
fi
LOCAL_LOAD_PERF_BASELINE=1 bash server/tools/local-load-performance-test.sh node tools/local-load-performance-checks.mjs baseline
bash server/tools/local-load-performance-test.sh node tools/local-load-performance-checks.mjs suite
bash server/tools/local-load-performance-test.sh node tools/local-load-performance-checks.mjs coverage
bash server/tools/local-load-performance-test.sh node tools/local-load-performance-checks.mjs mutations
