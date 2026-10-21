"""Generate the report from fresh checks and the verified deployed source."""
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / 'server/test-artifacts/operator-if-static-lines'


def read(name):
    return json.loads((ARTIFACT / name).read_text())


manifest = read('manifest.json')
final = read('final-summary.json')
shuffled = read('shuffled-summary.json')
coverage = read('changed-coverage.json')
types = read('type-comparison.json')
lint = read('lint-comparison.json')
mutations = read('mutations/results.json')
deployment = read('deployed.json')
live = read('live.json')
cleanup = read('cleanup.json')
gauntlet = read('gauntlet.json')
hashes = {name: row['after'] for name, row in manifest['changes'].items()}
assert gauntlet['passed'] and gauntlet['sourceHashes'] == hashes
assert final['failedFiles'] == shuffled['failedFiles'] == 0
assert final['newFailures'] == shuffled['newFailures'] == []
assert coverage['uncovered'] == types['newTypes'] == lint['newLint'] == []
assert len(mutations) == 14 and all(row['killed'] for row in mutations)
assert deployment['healthy'] and deployment['configurationPreserved'] and deployment['otherServicesPreserved']
assert live['durablePayloadPreserved'] and live['netSuiteWrites'] == live['localWrites'] == 0
assert cleanup['allTestContainersGone'] and cleanup['productionHealthy']
state = {'baseImage': manifest['baseImage'], 'sourceHashes': hashes}
tree_hash = hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()
result = {'passed': True, 'sourceTreeHash': tree_hash, 'at': deployment['at'],
          'tests': final['passed'], 'shuffledTests': shuffled['passed'],
          'changedLines': coverage['covered'], 'mutationRunsKilled': len(mutations),
          'productionHealthy': True, 'testCleanupVerified': True, 'livePayloadReady': live['ready']}
(ARTIFACT / 'completion.json').write_text(json.dumps(result, indent=2) + '\n')
report = f"""# Current sales-order IF lines — evidence

Spec: [operator-if-static-lines-spec.md](operator-if-static-lines-spec.md).
Tier 3. Spec approval: not obtained (autonomous run); the user authorized the
general fix. No independent human spec review occurred.

Source state: `{tree_hash}` (base image plus the three scoped source hashes).
The source/hash recipe is persisted in `tools/operator-if-static-lines-evidence.py`.
Deployed image: `{deployment['appImage']}`. Runtime hash verification passed.
Toolchain: Node {read('final-source.json')['node']}; dependencies remain pinned
by the existing package lock and isolated test images. No new dependencies,
migrations, commits, production data edits, or permission changes.

Reproduce checks: `IF_LINES_REUSE_BASELINE=1 bash server/tools/operator-if-static-lines-check.sh`.
Omit that variable to rerun the captured live baseline with its original tests.
Report: `python3 server/tools/operator-if-static-lines-evidence.py`.

| Acceptance criterion | Evidence | Result |
|---|---|---|
| S1 recorded SOA10159, only 7 PCS at 3445 | unit S1, live source/request check | pass |
| S2 completed/closed/absent rows omitted; open and new rows false | unit S2; four independent properties | pass |
| S3 exact selected quantity and pack fields; SQFT rule preserved | unit S3; existing rounding/pack suite; scoped diff | pass |
| S4 changed or unreadable source never posts | adversarial unit cases; real DB S7 | pass |
| S5 current read, Dispatch/kit guards, parts and receipt compatibility | native HTTP test, unit S5, complete posting suite | pass |
| S6 immutable command and no duplicate on recovery | real repository S6; native HTTP recovery | pass |
| S7 one load, no foreign draft loss, no finalize on failure | real repository and pickup finalizer S7 | pass |

| Final checks | Result |
|---|---|
| Full affected posting/yard suite | {final['passed']} passed, 0 failed, {final['files']} files |
| Shuffled suite, seed 10159 | {shuffled['passed']} passed, 0 failed |
| TypeScript | {types['baseline']} baseline / {types['final']} current diagnostics, 0 new |
| Scoped source and new test/tool lint | 0 new diagnostics; new code lint passed |
| Changed executable lines | {coverage['covered']}/{coverage['executable']} covered |
| Fault injection | 7/7 faults killed; independently 7/7 killed by properties alone |
| Properties | four properties, 400 generated examples per unit run |
| Secret scan | passed; no dependency changes |
| Actual HTTP and DB lifecycle | passed; network alone mocked, no posting logic mocked |
| Live app and public health | HTTP 200; configuration and other containers preserved |
| Disposable resources | all removed; docker ps and docker ps -a checked; production healthy |

The remote 2967 line of SOA10159 was fulfilled by IF157622 (1054767),
canonical orderLine 2. Failed requests still included that completed row with
`itemReceive: false`. Live read-only verification at {live['at']} returned
the current source and prepared the scoped transport request. Payload readiness:
{str(live['ready']).lower()}. Operator quantities/custom fields and the durable
payload remained intact. This verification created no NetSuite transaction.
Native creation after the operator retries remains an operational check; the
real HTTP test uses a boundary server modeling the static sublist rejection.

The patch preserves the saved payload/hash and filters only the transport
request. It also explicitly deselects new open fulfillable source rows, preventing
native defaults from fulfilling an operator-unselected line. Source changes after
the current read remain subject to NetSuite acceptance and IF verification.

The first broader run exposed an old no-source-read expectation. The spec now
explicitly requires the current read before SO posting. Its HTTP boundary fixture
and exact call assertions were updated; the original baseline tests are preserved
for replay. One mutation harness run failed to import a static module; copying
the existing public modules fixed that infrastructure failure without weakening
assertions. The final source is unchanged from the complete {final['passed']}-test
run; the finishing checks reuse its source-hash-verified regressions and rerun
coverage, mutations, static checks, and the full shuffled suite.

Skipped: dependency/license audit (no dependency change); UI visual change checks
(no UI change, existing pickup browser cases included); live test IF creation
(inventory operations remain in the operator flow). No new latency budget was
introduced; the existing transfer performance benchmark passed.
"""
(ROOT / 'server/test/operator-if-static-lines-evidence.md').write_text(report)
print(json.dumps(result))
