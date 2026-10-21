"""Build the receiving evidence report from completed checks and release verification."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
artifacts = root / 'test-artifacts/receiving-multi-yard'
release = root / 'deployments/receiving-multi-yard-20260930'

def read(path):
    return json.loads(path.read_text())

manifest = read(root / 'test/receiving-multi-yard-manifest.json')
checks = read(artifacts / 'gauntlet.json')
full = read(artifacts / 'full-comparison.json')
deployment = read(release / 'deployment-result.json')
state = read(release / 'manifest.json')
versions = read(artifacts / 'tool-versions.json')
coverage = read(artifacts / 'coverage/coverage-summary.json')
yard_coverage = next(value for key, value in coverage.items() if key.endswith('/src/receiving-yard-scope.js'))
public = read(artifacts / 'public-assets.json')
assert checks['passed'] and deployment['deployed']
assert not full['newFailures'] and not full['newDeadlines']
assert checks['changedCoverage']['covered'] == checks['changedCoverage']['total']
assert checks['focusedMutants'] == 6 and checks['propertyMutants'] == 3
assert versions['imageId'] and versions['databaseImageId']
for file, expected in manifest['after'].items():
    assert hashlib.sha256((release / 'candidate' / file).read_bytes()).hexdigest() == expected, file

report = {
    'task': 'SN1401728 / POB03969 receiving at the yard assigned to each PO line',
    'tier': 3,
    'specApproval': 'not obtained (autonomous run)',
    'spec': 'test/receiving-multi-yard-spec.md',
    'sourceFiles': manifest['after'],
    'releaseTreeHash': hashlib.sha256(json.dumps(state['allAfter'], sort_keys=True).encode()).hexdigest(),
    'candidateImageId': state['candidateImageId'],
    'rebaseProof': read(root / 'test/receiving-multi-yard-rebase-proof.json'),
    'tools': versions,
    'reproduce': 'RECEIVING_MULTIYARD_SOURCE_ROOT=deployments/receiving-multi-yard-20260930/candidate bash tools/receiving-multi-yard-gauntlet.sh',
    'acceptance': [
        {'criterion': 'List, vendor and item search find the PO at both line yards with scoped counts',
         'test': 'receiving-multi-yard.test.js: SN1401728 shape is discoverable by order vendor and own-yard item with scoped counts'},
        {'criterion': 'Detail shows four lines at 3445 and three at 2967; legacy requests, overrides and missing locations remain supported',
         'tests': ['receiving-multi-yard.test.js: detail and legacy one-yard requests expose only the selected yard lines',
                   'receiving-yard-scope.test.js: missing locations inherit the header and overrides retain their authority']},
        {'criterion': 'Foreign yards and line IDs cannot change drafts, including mixed-yard bulk requests; photos and recovery enforce grants',
         'tests': ['receiving-multi-yard.test.js: foreign lines and bulk requests are denied before draft changes',
                   'receiving-multi-yard.test.js: confirm unconfirm page confirmation and recovery retain the selected receiving yard']},
        {'criterion': '3445 receives four lines/five pallets; the payload explicitly skips 2967; its balances remain open and replay adds no quantities',
         'tests': ['receiving-multi-yard.test.js: receipt and posting target select five pallets at 3445 and explicitly skip 2967',
                   'receiving-multi-yard.test.js: a skipped line without a location retains its original header yard',
                   'receiving-multi-yard.test.js: the real receive route records only the selected yard and keeps the receipt job accessible',
                   'receiving-multi-yard.test.js: a completed yard receipt leaves the other yard open and prevents duplicate quantities']},
        {'criterion': 'TO/CO identity, allocations, completed order rules, split balances, receipt progress and order-wide concurrency retain their contracts',
         'testList': 'test/receiving-multi-yard-focused-tests.json'},
        {'criterion': 'Tablet requests include the chosen yard and the updated cache installs the matching client',
         'test': 'receiving-multi-yard-ui.test.js'},
        {'criterion': 'No dependencies, migrations, PO edits or actual receipts are required for this fix',
         'evidence': ['Eight runtime files in the scoped manifest', 'Read-only live preview and post-deployment checks',
                      'Release preserves application configuration and worker/database containers']}
    ],
    'results': {'focused': checks['tests'], 'changedLines': checks['changedCoverage'],
                'yardModuleBranches': yard_coverage['branches'],
                'mutantsKilled': checks['focusedMutants'], 'propertyMutantsKilled': checks['propertyMutants'],
                'properties': checks['properties'], 'static': checks['static'],
                'full': full, 'deployment': deployment, 'externalPublicAssets': public},
    'knownLimits': [
        'The full suite retains baseline failures and one browser test deadline; it is not globally green.',
        'Production validation is read-only; an actual NetSuite Item Receipt was not posted.',
        'Type checking covers the existing @ts-check authorization/posting modules and the new yard module; the entire legacy JavaScript application is not statically checked.',
        'The full suite ran on the receiving implementation before the test-only additions and the inherited SCM catalog change. Its missing browser-global fixture was rechecked with unchanged assertions; additional refresh/error-contract checks ran in the final focused suites and mutation layer. All 737 files were not repeated after these additions.',
        'A later unrelated SCM catalog first-load change was inherited from the live baseline. Removing those exact four baseline lines restores the previously tested server byte for byte; all receiving code is unchanged. The final receiving gauntlet was repeated on the current parent image.',
        'The unauthenticated external tablet-page probe returned HTTP 403. All three assets were verified by HTTP directly against the live application, but the public front door was not verified from this environment.',
        'Spec approval was autonomous; the user did not independently review the acceptance criteria.'
    ],
    'skipped': [
        {'layer': 'Dependency audit/license recheck', 'reason': 'No dependencies or lockfiles changed.'},
        {'layer': 'Migration rollback rehearsal', 'reason': 'No migration added; the application image has a retained rollback image.'},
        {'layer': 'Checkpoint commits', 'reason': 'The shared workspace contains unrelated ongoing edits; source hashes identify the release.'}
    ],
    'verificationRepairs': [
        'Used the existing browser-enabled test image after the first baseline image lacked Chromium.',
        'Recorded and bounded an unrelated hanging browser test, then completed the baseline remainder.',
        'Used the project per-file database isolation for the reverse-order suite to eliminate fixture collisions without changing assertions.',
        'Added an actual cache-install regression test and confirmed it fails against the old deployed assets.',
        'Copied the cache baseline fixture into mutation sandboxes so mutation failures cannot be attributed to a missing fixture.',
        'Supplied the selected-yard browser global to an extracted-function fixture, preserving every assertion and independently rechecking it against the same production source.',
        'Coverage identified missing authorized-refresh and invalid-PO-yard error-contract scenarios; added behavioral assertions and a specific error-contract mutant.',
        'Rebased the scoped patch onto the latest live stock-purchase release and repeated verification against that source.'
    ]
}
(root / 'test/receiving-multi-yard-evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'evidence': 'test/receiving-multi-yard-evidence.json',
                  'deployed': True, 'focused': checks['tests'], 'newFullFailures': len(full['newFailures'])}))
