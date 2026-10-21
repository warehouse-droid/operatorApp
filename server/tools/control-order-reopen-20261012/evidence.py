"""Write the verification report from the final preserved machine-readable results."""
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
TASK = Path(__file__).resolve().parent
OUT = SERVER / 'test-artifacts/control-order-reopen-20261012'

def result(name):
    return json.loads((OUT / name).read_text())

summary = result('summary.json')
static = result('static.json')
coverage = result('changed-coverage.json')
mutations = result('mutations.json')
cleanup = result('cleanup-final.json')
baseline = result('regression-baseline.json')
assert summary['fail'] == 0 and summary['tests'] == summary['pass']
assert not static['newTypes'] and not static['newLint'] and not static['testMessages']
assert not coverage['missing'] and all(row['killed'] for row in mutations)
assert not baseline['newFailures'] and not any(row['fail'] for row in baseline['results'])
assert cleanup['productionHealthy'] and not cleanup['testContainers'] and not cleanup['networks'] and not cleanup['volumes']
total_lines = sum(row['changedExecutable'] for row in coverage['files'])
covered_lines = sum(row['covered'] for row in coverage['files'])
property_mutants = [row for row in mutations if row['property']]
versions = {'node': summary['node']}
for package in ['typescript', 'eslint', 'c8', 'playwright', 'fast-check']:
    versions[package] = json.loads((SERVER / 'test-artifacts/operator-to-yard-flow-tooling/node_modules' / package / 'package.json').read_text())['version']
artifacts = [TASK / name for name in ['files.json','run.py','check.mjs','coverage.py','mutations.mjs','deploy.py','live.mjs']]
artifacts += [SERVER / 'test/support/control-order-reopen-fixture.mjs']
artifact_hashes = {str(file.relative_to(SERVER)): hashlib.sha256(file.read_bytes()).hexdigest() for file in artifacts}
(OUT / 'tooling-manifest.json').write_text(json.dumps({'versions': versions, 'artifactHashes': artifact_hashes}, indent=2) + '\n')

report = f'''# Control order reopening verification

Spec approval: not obtained (autonomous run). Tier 3, scoped to local Operator
progress, authorization, concurrent work and retained evidence.

The release adds Control → Order Reopen and identifies the affected order and
actual progress in PO-link errors, with a named operator only when the evidence
supports that attribution. Reopening clears local quantities and ownership,
preserves ordered lines, assignments, inbound progress, images and history,
and records an immutable correction. Recorded NetSuite transactions, received
cargo, active posting/reload/consolidation and started Driver work remain guarded.

SOA08800 and SOA08801 were inspected read-only. No real order reset was used in
development, testing or release verification. The user will reopen SOA08801.
The retained imported progress diagnosis is preserved in the artifact directory.

Final fresh command: `python3 server/tools/control-order-reopen-20261012/run.py final`

| Layer | Final result |
| --- | --- |
| Feature, browser, concurrency and scoped regressions, including reordered execution | {summary['pass']}/{summary['tests']} pass, 0 fail |
| Same captured live baseline against all {len(baseline['results'])} regression files | All pass; 0 new failures |
| Changed executable lines, including real browser coverage | {covered_lines}/{total_lines} covered |
| Manual non-equivalent mutants | {len(mutations)}/{len(mutations)} killed |
| Applicable mutants against properties alone | {len(property_mutants)}/{len(property_mutants)} killed |
| Type comparison | {static['baselineTypes']} existing baseline diagnostics, {static['currentTypes']} current, 0 new |
| Runtime and test lint | 0 new runtime issues, 0 test issues |
| Isolated containers, database storage and networks | Removed; production healthy |

Source state: `{summary['sourceHash']}`. Runtime/test hashes are in `summary.json`;
tool versions and verification script hashes are in `tooling-manifest.json`.
No packages were added and no commits were created. The release uses the exact
captured live image plus 16 task overlays; unrelated workspace edits are preserved.

The executable specification is `test/control-order-reopen-spec.md`. Detailed
behavior is exercised in the Control repository/HTTP/local-order integration
tests, operator attribution tests and progress-message properties. Existing
packing-independent PO/TO dependencies, packing-only date planning, pickup
photo gates, yard authorization, consolidation loading, reload photo entry,
posting persistence and Driver reopening are included in the regression set.

Observed RED: 16 new feature assertions failed on the absent baseline feature;
3 message assertions failed; both shared-lock races failed; both attribution
ownership cases failed before their correction. One authorization mutant
initially survived because a foreign-yard rejection masked the role check.
An independent same-yard Operator denial test closed that gap. Original
assertions were retained. Invalid early group/VRMA fixture setup was corrected;
the baseline snapshot now includes every test support file and matrix.

Meaningful properties cover arbitrary local packed/loaded quantities with exact
target/photo conservation, and every member/operator pair in a grouped error.
The loading, packing, photo-loss and name-loss mutants are also killed by these
properties alone. Other mutants exercise authorization, stale previews, retry
safety and real pickup/Driver locks.

Checks intentionally outside this scope: live NetSuite writes and real order
resets (the user requested preservation), exhaustive testing of all unrelated
repository features, and external object-storage byte transfers (existing photo
references and records are retained exactly). No dependency audit was needed
because the dependency set did not change. Existing repository type debt is
reported above; this change adds none. Assertions and changed-line coverage
describe the tested contract rather than every possible business workflow.

Deployment and rollback metadata are retained in
`server/deployments/control-order-reopen-20261012`; live availability, source
hashes and read-only order inspection are recorded in `deployment-result.json`.
'''
(SERVER / 'test/control-order-reopen-evidence.md').write_text(report)
print(json.dumps({'tests': summary['tests'], 'pass': summary['pass'], 'changedLines': total_lines,
    'mutants': len(mutations), 'sourceHash': summary['sourceHash']}))
