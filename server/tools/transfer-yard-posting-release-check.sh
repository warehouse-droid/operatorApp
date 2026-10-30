#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
release="$repo/server/deployments/transfer-yard-posting-20261021"
status=0
TO_YARD_CANDIDATE_ROOT="$release/candidate" \
TO_YARD_TEST_IMAGE=mbbs-operator-app:transfer-yard-posting-20261021 \
  bash server/tools/transfer-yard-posting-test.sh node tools/transfer-yard-posting-suite.mjs final \
  > "$release/validation.log" 2>&1 || status=$?
python3 - "$release" "$status" <<'PY'
import hashlib, json, pathlib, re, sys
release = pathlib.Path(sys.argv[1])
status = int(sys.argv[2])
log = (release / 'validation.log').read_text()
sum_key = lambda key: sum(map(int, re.findall(r'^ℹ '+key+r' (\d+)$', log, re.M)))
failures = sorted(set(re.findall(r'^✖ (.+?) \([\d.]+ms\)$', log, re.M)))
baseline = json.loads((release.parents[1] / 'test-artifacts/transfer-yard-posting-20261021/final/tests.json').read_text())
manifest = json.loads((release / 'manifest.json').read_text())
result = {'tests': sum_key('tests'), 'passedTests': sum_key('pass'), 'failedTests': sum_key('fail'),
          'skippedTests': sum_key('skipped'), 'failures': failures, 'runnerExitCode': status,
          'newFailures': [name for name in failures if name not in baseline['baseline']['failures']],
          'candidateTreeHash': manifest['candidateTreeHash']}
print(json.dumps(result, indent=2))
assert result['tests'] == 300 and result['skippedTests'] == 0
assert result['failedTests'] == len(failures) and not result['newFailures']
assert status == (1 if failures else 0)
for name, digest in manifest['candidateTree'].items():
    assert hashlib.sha256((release/'candidate'/name).read_bytes()).hexdigest() == digest, name
result['passed'] = True
(release / 'validation-passed.json').write_text(json.dumps(result, indent=2)+'\n')
PY
