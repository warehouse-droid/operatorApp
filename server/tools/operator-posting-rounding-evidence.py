"""Assemble release evidence from the final saved results, without private data."""
import datetime
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / 'server/test-artifacts/operator-posting-rounding'


def read(name):
    return json.loads((ARTIFACT / name).read_text())


manifest = read('manifest.json')
gauntlet = read('gauntlet.json')
assert gauntlet['passed']
assert gauntlet['sourceHashes'] == {name: row['after'] for name, row in manifest['changes'].items()}
lock = json.loads((ROOT / 'server/package-lock.json').read_text())
coverage = read('changed-coverage.json')
assert not coverage['uncovered']
mutations = read('mutations/results.json')
assert len(mutations) == 10 and all(row['killed'] for row in mutations)
assert sum(row['propertyOnly'] for row in mutations) == 5
report = {
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'policy': {'unit': 'SQFT', 'strictVarianceLimit': 0.01, 'postingQuantity': 'NetSuite',
               'localCompletionQuantity': 'NetSuite', 'immutablePhysicalEvidencePreserved': True},
    'spec': 'server/test/operator-posting-rounding-spec.md',
    'specApproval': 'not obtained (autonomous run); user explicitly specified the quantity rule and authorized deployment',
    'tier': 3,
    'entryPoint': 'bash server/tools/operator-posting-rounding-gauntlet.sh',
    'sourceState': hashlib.sha256(json.dumps(gauntlet['sourceHashes'], sort_keys=True).encode()).hexdigest(),
    'sourceHashes': gauntlet['sourceHashes'],
    'tools': {'node': read('final-source.json')['node'], **{name: lock['packages']['node_modules/' + name]['version']
              for name in ['fast-check', 'c8', 'eslint', 'typescript']}},
    'baseline': {'files': len(read('baseline.json')), 'tests': sum(row['tests'] for row in read('baseline.json')),
                 'failedFiles': sum(row['exitCode'] != 0 for row in read('baseline.json'))},
    'regressions': read('final-summary.json'),
    'randomizedRegressions': read('shuffled-summary.json'),
    'types': read('type-comparison.json'),
    'lint': read('lint-comparison.json'),
    'changedCoverage': coverage,
    'quantityModuleCoverage': read('coverage/coverage-summary.json')['/app/src/operator-netsuite-posting-quantity.js'],
    'mutationLog': 'mutations.log',
    'mutationResults': mutations,
    'mutationChecks': {'plausibleBugs': 5, 'fullSuiteRuns': 5, 'propertyOnlyRuns': 5},
    'scenarioTests': {
        'R1,R2,R3': 'unit/operator-posting-rounding.test.js: all IF/IR sources, both rounding directions, exact 0.01 boundary',
        'R4': 'unit/operator-posting-rounding*.test.js: source/external ID, item, location, unit, duplicate/missing/unexpected identities and invalid quantities',
        'R5': 'integration/operator-posting-rounding.test.js: existing-IF recovery, repeat/concurrent recovery, local rollback and immutable requests',
        'R8': 'unit/operator-posting-rounding*.test.js: canonical payloads, live SO/PO readers, TO pre-post guards, automatic SO and direct PO posting',
        'R9': 'integration/operator-posting-rounding.test.js: local pickup and receipt completion in both directions, no tiny remainder, actual direct-PO counter',
        'P1,P2,P3,P4,P5': 'unit/operator-posting-rounding.test.js: 2100 seeded quantity, payload, identity and non-SQFT property cases'
    },
    'iterationNotes': [
        'The original 0.0002 scenario was superseded by the user threshold clarification to strictly below 0.01 SQFT.',
        'RED reproduced the original verifier and payload defects; one draft fixture initially used an unsupported TO IF operation and was corrected without changing its assertions.',
        'A generated large-quantity exact-boundary counterexample required a bounded floating-point guard that narrows acceptance and never rounds the NetSuite quantity.',
        'Static checks required splitting new functions below the existing complexity limit; a test helper was simplified without changing assertions.',
        'Direct receipt RED observed the old cached counter 60.765 instead of NetSuite 60.76; the counter now uses verified accounting quantity.',
        'The first read-only live audit used a nonexistent local_order_keys column; its corrected query reads the JSON snapshot and the rerun passed without prior mutations.',
        'The recovery itself completed, but multiple application log lines caused its Python JSON capture to fail. The capture was corrected and a fresh read-only verification compared the result with the preserved pre-recovery fingerprint; recovery was not repeated.'
    ],
    'limitsAndSkippedLayers': [
        'The full unrelated repository suite was not rerun: the workspace contains extensive unrelated work and known failures. All 57 relevant posting component files were compared against the exact live-source baseline and randomized.',
        'Existing 866 compiler diagnostics and existing lint complexity diagnostics are reported; the requirement is zero new diagnostics.',
        'Dependency audit/license installation skipped because no dependencies or lockfiles were changed; the source and test/tool diff was scanned for secrets.',
        'No migration or rollback-data restoration test needed because this release adds no schema change. The deployment retains the exact previous image and rolls it back on failed health verification.',
        'No throughput benchmark: no throughput budget was specified. The added SO read uses the existing bounded NetSuite request path.',
        'Ambiguous or multiple-local-line quantity mappings stay held; rounding never authorizes identity or unit drift.'
    ],
    'deployed': read('deployed.json'),
    'recovered': read('recovered.json'),
    'cleanup': read('cleanup.json')
}
assert report['regressions']['failedFiles'] == report['randomizedRegressions']['failedFiles'] == 0
assert report['types']['newTypes'] == report['lint']['newLint'] == []
assert report['recovered']['status'] == 'completed' and report['recovered']['transforms'] == 0
(ARTIFACT / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'evidence': 'server/test-artifacts/operator-posting-rounding/evidence.json',
                  'tests': report['regressions']['tests'], 'changedCoverage': f"{coverage['covered']}/{coverage['executable']}",
                  'deployed': report['deployed']['healthy'], 'recovered': report['recovered']['status']}))
