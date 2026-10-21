"""Assemble retained, verified evidence without accessing production credentials."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
OUT = SERVER / 'test-artifacts/direct-po-split-status-20261015'
checks = json.loads((OUT / 'checks.json').read_text())
split_range = json.loads((OUT / 'range-checks.json').read_text())
verified = json.loads((OUT / 'verified.json').read_text())
range_live = json.loads((OUT / 'range-live.json').read_text())
assert checks['passed'] and verified['status'] == 'Completed'
assert split_range['passed'] and split_range['tests']['passed'] == 20
assert range_live['installedSplitMatcherVerified'] and range_live['status'] == 'Completed'
assert all(row['failed'] == 0 and row['status'] == 0 for row in checks['tests'] + checks['shuffled'])
assert all(row['killed'] and row['propertyKilled'] for row in checks['mutations'])
for name, expected in {**checks['sourceHashes'], **split_range['sourceHashes']}.items():
    assert hashlib.sha256((SERVER / name).read_bytes()).hexdigest() == expected

own_files = [
    'migrations/291_direct_po_materialized_split_status.sql',
    'test/mbt/integration/direct-po-materialized-split.test.js',
    'test/mbt/integration/direct-po-materialized-split-range.test.js',
    'test/dispatch/integration/direct-linked-po-group-lifecycle.test.js',
    'tools/direct-po-split-status-recovery.mjs',
    'tools/direct-po-split-status-checks.mjs',
    'tools/direct-po-split-status-mutation-loader.mjs',
    'tools/direct-po-split-status-deploy.py',
    'tools/direct-po-split-status-evidence.py',
    'tools/direct-po-split-range-checks.mjs',
]
source_hashes = {name: hashlib.sha256((SERVER / name).read_bytes()).hexdigest() for name in own_files}
dependencies = SERVER / 'test-artifacts/operator-to-yard-flow-tooling/node_modules'
versions = {name: json.loads((dependencies / name / 'package.json').read_text())['version']
            for name in ['pg', 'fast-check', 'c8', 'eslint']}
report = {
    'result': 'passed',
    'spec': json.loads((OUT / 'spec.json').read_text()),
    'source': {
        'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'dirtyWorkspacePreserved': True,
        'changedFileHashes': source_hashes,
        'changedFilesTreeHash': hashlib.sha256(json.dumps(source_hashes, sort_keys=True).encode()).hexdigest(),
    },
    'entryPoint': 'bash server/tools/operator-to-yard-flow-test.sh node tools/direct-po-split-status-checks.mjs',
    'toolchain': {'node': '20.20.2', 'packages': versions,
                  'lockfileSha256': hashlib.sha256((SERVER / 'package-lock.json').read_bytes()).hexdigest()},
    'acceptanceEvidence': {
        'exactSplitLifecycle': 'direct-po-materialized-split.test.js: materialized split references match the exact allocation and advance Direct ship through In Transit to Completed',
        'parentSplitCoveragePreserved': 'direct-linked-po-group-lifecycle.test.js: all 10 existing cases',
        'wrongSplitAndCoverageRejected': 'direct-po-materialized-split.test.js: sibling splits; wrong item, source line, insufficient quantity, missing membership; 40 generated cases',
        'statusOnlyHistoricalRecovery': 'direct-po-materialized-split.test.js: historical completion recovery, wrong identity/proof rejection, unexpected receipt rollback, reopened visit rejection; applied.json and verified.json',
        'atomicAndIdempotent': 'direct-po-materialized-split.test.js: migration rollback, recovery rollback and idempotence; guarded SERIALIZABLE production transaction',
    },
    'validation': {
        'tests': sum(row['tests'] for row in checks['tests']),
        'passed': sum(row['passed'] for row in checks['tests']),
        'failed': sum(row['failed'] for row in checks['tests']),
        'baselineTests': sum(row['tests'] for row in checks['baseline']),
        'reorderedPassed': sum(row['passed'] for row in checks['shuffled']),
        'manualMutantsKilled': len(checks['mutations']),
        'propertyAloneMutantsKilled': len(checks['mutations']),
        'propertySeed': checks['propertySeed'],
        'propertyCases': checks['propertyCases'],
        'recoveryCoverage': checks['coverageReport'],
        'lintAndSyntax': 'passed; retained lint.log and syntax.log',
    },
    'production': verified,
    'splitRangeSupplement': split_range,
    'splitRangeLiveVerification': range_live,
    'productionApproval': 'Explicit user approval obtained: Apply the fix. The first attempt was blocked by automatic review because the initial request asked for an explanation; no mutation occurred before approval.',
    'cleanup': 'The standard wrapper registered teardown before tests, removed the isolated Compose project with --volumes --remove-orphans, and checked both docker ps and docker ps -a. Production health passed.',
    'scopeReview': 'One shared SQL identity condition changed. The targeted repair adds one completion event from existing proof. No new runtime dependencies, secrets, public API changes, application restart, NetSuite writes or receipt jobs.',
    'limitsAndSkippedLayers': {
        'specApproval': 'not obtained (autonomous run); no independent spec review',
        'sqlLineCoverage': checks['sqlCoverage'],
        'staticTypes': checks['types'],
        'fullRepositorySuite': checks['fullRepositorySuite'],
        'concurrencyStress': 'Not run. Production correction uses SERIALIZABLE isolation, source fingerprints and row locks; aborts on changed input.',
        'performanceBenchmark': 'No latency budget stated; feature execution and live schedule query exercised.',
        'supplyChainAudit': 'No dependencies added; existing locked tooling reused.',
        'uiBrowser': 'No UI code changed; real schedule repository output and application health verified.',
    },
    'failuresResolved': [
        'RED reproduced missing split matching and the unimplemented recovery.',
        'An initial broader run saw unrelated received-quantity field failures; a concurrent workspace fix resolved those before the final baseline. No unrelated implementation was changed by this task.',
        'Reusing one test database across suites exposed leftover fixture rows. Each file now uses a fresh disposable database cloned from the migrated template.',
        'Coverage initially encountered another task\'s root-owned shared output. It now uses this task\'s own temporary coverage directory.',
        'Forced database removal raced with pg-pool\'s asynchronous socket close. Normal DROP DATABASE now waits for those closing connections rather than forcibly terminating them.',
        'A repeated whole-record fingerprint check after the S1-S20 supplement differed from the immediate post-repair check; the live group had a later update timestamp. The original atomic repair and immediate check passed. A separate later read verified the installed SQL body, exact allocation references, delivery readiness, original completion event, quantities and zero receipt jobs; later-source-observation.json retains the later source fields.',
    ],
}
(OUT / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'result': report['result'], **report['validation']}))
