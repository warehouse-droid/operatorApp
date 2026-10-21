"""Summarize the persisted gauntlet output for the exact scoped candidate."""
import datetime
import hashlib
import json
from pathlib import Path

server = Path(__file__).resolve().parents[2]
evidence = server / 'artifacts/receipt-extra-charges-20261019'
release = server / 'deployments/receipt-extra-charges-20261019'
read = lambda root, name: json.loads((root / name).read_text())
manifest = read(release, 'manifest.json')
quality = read(evidence, 'quality-results.json')
baseline = read(evidence, 'baseline-results.json')
results = read(evidence, 'final-results.json')
for file in manifest['files']:
    digest = hashlib.sha256((release / 'candidate' / file).read_bytes()).hexdigest()
    assert digest == quality['source'][file] == manifest['candidateTree'][file]
assert not quality['types']['newErrors'] and not quality['lint']['newErrors']
assert all(not row['uncovered'] for row in quality['coverage'].values())
assert len(quality['mutations']) == 24 and all(row['killed'] for row in quality['mutations'])
for row in results:
    if row['file'].startswith('tools/'):
        assert row['exit'] == 0 and row['pass'] == row['tests'] and row['tests'] > 0
    else:
        prior = next(item for item in baseline if item['file'] == row['file'])
        assert (row['exit'], row['tests'], row['failures']) == (prior['exit'], prior['tests'], prior['failures'])
new = [row for row in results if row['file'].startswith('tools/')]
runtime = [release / 'candidate' / file for file in manifest['files']]
patterns = ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', 'AKIA', 'ghp_']
assert not any(token in path.read_text() for path in runtime for token in patterns)
for file, digest in manifest['packages'].items():
    assert hashlib.sha256((release / 'candidate' / file).read_bytes()).hexdigest() == digest
report = {
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'state': 'candidate_validated',
    'spec': str(Path(__file__).with_name('spec.json')),
    'specApproval': 'not obtained separately (autonomous run); user explicitly authorized local repair and application fix',
    'candidateTreeHash': manifest['candidateTreeHash'],
    'reproduce': 'bash server/tools/receipt-extra-charges/gauntlet.sh',
    'tests': {'total': sum(row['tests'] for row in results), 'pass': sum(row['pass'] for row in results),
        'new': sum(row['tests'] for row in new), 'newPassed': sum(row['pass'] for row in new),
        'newFailures': 0, 'unchangedBaselineFailures': [row for row in results if row['fail']]},
    'properties': {'seed': 404215183, 'casesPerProperty': 100, 'properties': 3,
        'mutantsAlsoKilledByPropertySuiteAlone': 12},
    'quality': quality,
    'scope': 'Three runtime files; original requests and strict inventory validator unchanged; no schema, package, configuration or NetSuite transaction changes',
    'capabilityReview': 'One additional read of the source PO only when the receipt includes a candidate purchase charge; no new write capability',
    'red': {'unit': read(evidence, 'red-results.json'), 'integration': read(evidence, 'red-integration-results.json'),
        'preexistingRejectionAssertions': 'Accept-all mutant fails the defensive regression assertions; ordinary-receipt behavior is protected by unnecessary-source-reads mutant'},
    'behaviorMapping': {
        'actualIR15183AndSourceProof': 'unit.test.mjs actual IR15183, attack cases and runtime adapter cases',
        'partialAndFollowupBalance': 'integration.test.mjs partial receipt and follow-up receipt tests',
        'immutableRequestAndChargeAudit': 'unit.test.mjs actual IR15183 plus integration.test.mjs partial receipt',
        'noDuplicateRecoveryAndConcurrency': 'integration.test.mjs held receipt with four concurrent workers and repeated command processing',
        'rollbackAndVisibleHeldIR': 'integration.test.mjs finalizer failure, source read failure and unexpected inventory',
        'quantityFinancialAndIdentityBounds': 'property.test.mjs generated valid and invalid charge evidence, 12 manual mutants',
        'ordinaryPathReadBudget': 'unit.test.mjs ordinary receipts plus property.test.mjs ordinary generated receipts',
        'runtimeHealthAndActualNetSuite': 'deployment-result.json and live-receipt-verification.json after deployment'
    },
    'knownLimits': [
        'Full affected posting/receiving suites were run; the entire unrelated MBT repository suite was not run.',
        'One older follow-up test expects a payload without current packing fields and fails identically on the captured live baseline.',
        'The imported source graph has 8545 pre-existing TypeScript diagnostics under the ad hoc checkJs command; there are zero new diagnostics.',
        'The service has one pre-existing complexity lint error; this change adds no lint diagnostics.',
        'Only source-verified Other Charge purchase lines qualify. Unverified material or identity mismatches continue to require review.',
        'NetSuite transform boundaries are mocked in disposable tests; deployed verification reads the real existing IR and PO without creating a transaction.'
    ],
    'skipped': {'dependencyAudit': 'No dependency or lockfile changes', 'gitCommit': 'Dirty shared workspace; scoped source-tree hashes identify the candidate'},
    'validationIssuesResolved': [
        'Initial isolated mounts attempted to create a file beneath a read-only source mount; a separate red source tree fixed the harness.',
        'The baseline type-check mount initially omitted public modules; matching captured public trees produced equal baseline and candidate diagnostic sets.',
        'Two new complexity diagnostics were removed by splitting source-document validation and simplifying source-proof transfer; the original service diagnostic remains unchanged.',
        'The mutation sandbox initially lacked shared public modules; a read-only link and unmodified controls now verify the harness before mutations.',
        'Removing only the extra location comparison was redundant with the unchanged strict validator and survived; the final location mutant instead incorrectly trusts the returned location as source evidence and must be killed by both suites.'
    ],
    'cleanup': {'compose': 'down --volumes --remove-orphans registered before tests; per-test cloned databases dropped in finally',
        'manual': 'bounded --rm containers and EXIT teardown; docker ps and ps -a saved for each run'}
}
for name in ['deployment-result.json', 'live-receipt-verification.json', 'final-cleanup.json']:
    if (release / name).exists():
        report[name.removesuffix('.json')] = read(release, name)
if all((release / name).exists() for name in ['deployment-result.json', 'live-receipt-verification.json']):
    report['state'] = 'deployed_and_live_verified'
(evidence / 'evidence-report.json').write_text(json.dumps(report, indent=2) + '\n')
(release / 'validation-passed.json').write_text(json.dumps({'passed': True,
    'candidateTreeHash': manifest['candidateTreeHash'], 'evidence': str(evidence / 'evidence-report.json')}, indent=2) + '\n')
print(json.dumps({'state': report['state'], 'tests': report['tests'], 'candidateTreeHash': manifest['candidateTreeHash']}))
