"""Verify the exact scoped release source using disposable test databases."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import os
import subprocess

root = Path(__file__).resolve().parents[1]
release = root / 'test-artifacts/bin-planner-reuse-release-20260927'


def run(mode):
    with (release / (mode + '.log')).open('w') as output:
        result = subprocess.run(['bash', str(root / 'tools/bin-planning-test.sh'), 'node', 'tools/bin-planning-suites.mjs', mode],
                                env=dict(os.environ, BIN_PLANNING_CHECK='reuse-release-' + mode,
                                         BIN_PLANNING_SOURCE_ROOT=str(release / 'candidate')),
                                stdout=output, stderr=subprocess.STDOUT, timeout=600)
    return mode, result.returncode


with ThreadPoolExecutor(max_workers=2) as pool:
    results = dict(pool.map(run, ['feature', 'baseline']))
report = {'passed': all(code == 0 for code in results.values()), 'checks': results}
(release / 'release-checks.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report))
raise SystemExit(0 if report['passed'] else 1)
