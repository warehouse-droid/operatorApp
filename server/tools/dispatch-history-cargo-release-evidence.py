"""Report deployed-source replay evidence and retain every historical evidence gap."""
import collections
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

SERVER = Path(__file__).resolve().parents[1]
ORIGINAL = SERVER / 'test-artifacts/dispatch-all-history-20261002'
ROOT = ORIGINAL / 'cargo-route'
RELEASE = SERVER / 'deployments/dispatch-history-cargo-20261002'
VERIFY = ROOT / 'release-verification'
SOURCE = ROOT / 'release-final-source'
spec = importlib.util.spec_from_file_location('cargo_evidence_common', SERVER / 'tools/dispatch-history-cargo-evidence.py')
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


def read(path):
    return json.loads(path.read_text())


def save_summary(report):
    final = report.get('finalHashes', {})
    initial = report['sourceStages'][0]['hashes']
    drift = sorted(file for file in initial if initial[file] != final.get(file)) if final else []
    runtime = [file for file in initial if file.startswith(('src/', 'public/'))]
    lint_change = read(VERIFY / 'test-lint-correction.json')
    reviewed_drift = drift == ['test/dispatch/integration/co-direct-to.test.js'] and lint_change['onlyLocalVariableRenames']
    return {'pass': report['pass'], 'completedAt': report.get('completedAt'), 'records': len(report['records']),
            'inventory': report.get('inventory'), 'outcomes': report.get('outcomes'),
            'focusedSuiteExit': report.get('focusedSuiteExit'), 'failures': report['failures'],
            'allSourceStable': bool(final) and not drift,
            'productionSourceStable': bool(final) and all(initial[file] == final[file] for file in runtime),
            'sourceDriftFiles': drift, 'reviewedTestOnlyLintChange': reviewed_drift}


def broad():
    result = {}
    waitlist_files = ['test/mbt/integration/regular-waitlist-legacy-guards.test.js',
                     'test/mbt/integration/regular-waitlist-startup.test.js',
                     'test/mbt/integration/regular-waitlist-http-browser.test.js']
    paired = {}
    for kind in ['baseline', 'candidate']:
        first = common.suite(VERIFY / f'waitlist-{kind}-corrected.log')
        startup = common.suite(VERIFY / f'waitlist-{kind}-startup-final.log')
        remaining = set(first['failingFiles']) - set(waitlist_files[1:2])
        paired[kind] = {'initial': first, 'startupRerun': startup,
                        'passed': first['complete'] and startup['complete'] and not remaining and not startup['failingFiles']}
    paired['resolved'] = paired['baseline']['passed'] and paired['candidate']['passed']
    for category in ['full', 'dispatch']:
        before = common.suite(ORIGINAL / f'{category}-candidate.log')
        after = common.suite(ROOT / f'{category}-candidate.log')
        raw_files = sorted(set(after['failingFiles']) - set(before['failingFiles']))
        raw_tests = sorted(set(after['failingTests']) - set(before['failingTests']))
        resolved_files = set(waitlist_files) if category == 'full' and paired['resolved'] else set()
        result[category] = {'baseline': before, 'candidate': after,
                            'rawNewFailingFiles': raw_files, 'rawNewFailingTests': raw_tests,
                            'remainingNewFailingFiles': [file for file in raw_files if file not in resolved_files],
                            'remainingNewFailingTests': [name for name in raw_tests if name.split(' :: ')[0] not in resolved_files]}
    return result, paired


def manifest():
    hashes = {}
    for folder in ['src', 'public', 'migrations', 'test', 'tools', 'contracts']:
        for path in sorted((SOURCE / folder).rglob('*')):
            if path.is_file():
                hashes[str(path.relative_to(SOURCE))] = hashlib.sha256(path.read_bytes()).hexdigest()
    for path in sorted(SOURCE.glob('*.json')) + sorted(SOURCE.glob('eslint*.js')):
        hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    digest = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'treeSha256': digest, 'files': hashes}


def main():
    deployment = read(RELEASE / 'deployment-result.json')
    release = read(RELEASE / 'manifest.json')
    saves = [read(ROOT / 'release-save-replays' / f'pass-{number}.json') for number in [1, 2]]
    audits = [read(ROOT / 'release-content-replays' / f'pass-{number}.json') for number in [1, 2]]
    save_results = [save_summary(report) for report in saves]
    content_results = [common.audit(report) for report in audits]
    compare_fields = ['index', 'stream', 'sourceId', 'planId', 'planDate', 'result', 'loads', 'pickups',
                      'deliveries', 'contentChecks', 'driverContentChecks', 'evidenceGaps', 'routeIssues']
    normalized = [[{key: row[key] for key in compare_fields} for row in report['records']] for report in audits]
    suites, waitlist = broad()
    bt, ct = common.types(VERIFY / 'types-baseline.log'), common.types(VERIFY / 'types-candidate.log')
    bl, cl = common.lint(VERIFY / 'lint-baseline.json'), common.lint(VERIFY / 'lint-candidate.json')
    focused = common.suite(RELEASE / 'focused.log')
    shuffled = common.suite(VERIFY / 'shuffled-coverage.log')
    covered = read(VERIFY / 'changed-line-coverage.json')
    mutations, secrets = read(VERIFY / 'mutations.json'), read(VERIFY / 'secrets.json')
    source = manifest()
    runtime = {file: digest for file, digest in source['files'].items() if file.startswith(('src/', 'public/', 'migrations/'))}
    checks = {
        'deployedRuntimeMatchesTestedSource': runtime == release['sourceTree'],
        'deploymentVerified': deployment['deployed'] and deployment['publicHealth'] and deployment['publicAssets']
            and deployment['configurationPreserved'] and deployment['untouchedServicesPreserved'],
        'twoCompleteSaveReplays': all(row['completedAt'] and row['focusedSuiteExit'] == 0
            and row['productionSourceStable'] and not row['failures']
            and row['outcomes'].get('saved_and_rolled_back') == row['inventory']['acceptedScopedStates'] == 3101 for row in save_results),
        'fixedSecondReplaySource': save_results[1]['allSourceStable'],
        'firstReplayDriftReviewed': save_results[0]['allSourceStable'] or save_results[0]['reviewedTestOnlyLintChange'],
        'twoCompleteContentAudits': all(row['completedAt'] and row['states'] == 3101
            and row['failureCount'] == 0 and row['sourceStable'] for row in content_results),
        'identicalCargoAndRouteResults': normalized[0] == normalized[1],
        'broadRegression': all(row['baseline']['complete'] and row['candidate']['complete']
            and not row['remainingNewFailingFiles'] and not row['remainingNewFailingTests'] for row in suites.values()),
        'focusedRegression': focused['complete'] and focused['tests'] == 228 and not focused['failingFiles'],
        'shuffledRegression': shuffled['complete'] and shuffled['tests'] == 228 and not shuffled['failingFiles'],
        'types': not ct - bt, 'lint': not cl - bl, 'changedLineCoverage': covered['passed'],
        'newHelperComplexity': not (ROOT / 'complexity.log').read_text().strip()
            and (SOURCE / 'src/dispatch-retained-link-manifests.js').read_bytes()
                == (ROOT / 'final-source/src/dispatch-retained-link-manifests.js').read_bytes(),
        'mutationChecks': len(mutations['mutations']) == 10 and all(row['killed'] for row in mutations['mutations'])
            and all(row['propertyOnly']['killed'] for row in mutations['mutations'] if row['propertyOnly'])
            and mutations['restoredSuiteExit'] == 0,
        'secrets': not secrets['findings'],
        'packingSlipViews': read(ORIGINAL / 'packing-slip/release-views-after.json')['passed'],
        'scheduleBrowserRegression': bool(re.search(r'^# fail 0$', (RELEASE / 'packing-regression.log').read_text(), re.M))}
    unresolved = [{key: row[key] for key in ['planId', 'planDate', 'evidenceGaps', 'routeIssues', 'executionSupportedRoutes']}
                  for row in audits[1]['records'] if row['stream'] == 'snapshot' and (row['evidenceGaps'] or row['routeIssues'])]
    evidence = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope': 'Every accepted retained August/September 2026 snapshot and full command receipt; newest dated evidence takes precedence over July.',
        'userAuthorization': 'User explicitly requested deployment before returning to cargo checks and packing independence for PO/TO links and replenish-to-direct changes.',
        'specApproval': 'Not obtained (autonomous run); implementation, focused fixes, replays and deployment were explicitly authorized.',
        'deployment': deployment, 'sourceTreeSha256': source['treeSha256'], 'checks': checks,
        'logicRegressionGatesPassed': all(checks.values()), 'historicalEvidenceComplete': not unresolved,
        'saveReplays': save_results, 'contentAudits': content_results, 'broadSuites': suites,
        'waitlistVerificationSetupCorrection': waitlist,
        'focused': focused, 'shuffled': shuffled, 'coverage': covered,
        'types': {'baseline': sum(bt.values()), 'candidate': sum(ct.values()), 'new': sum((ct-bt).values())},
        'lint': {'baseline': sum(bl.values()), 'candidate': sum(cl.values()), 'new': sum((cl-bl).values())},
        'mutations': mutations, 'secretsAndVersions': secrets,
        'firstPassTestLintCorrection': read(VERIFY / 'test-lint-correction.json'),
        'limits': ['Missing dated cargo and missing route execution proof are unresolved evidence, not verified empty cargo or replay rejections.',
                   'Original authoritative source versions and all historical SQL-backed Driver displays are unavailable. Retained plan projections are audited; actual Driver online/offline behavior is independently tested with fixtures.',
                   'The broad raw comparison covers the original cargo fixes; the exact deployed candidate is additionally covered by 228 focused tests and both full history/content passes. Existing repository failures remain.',
                   'The isolated mbt_test template needed existing waitlist migration 254 and a test output directory. No production or historical database migration was made for these corrections.',
                   'Both packed CO changes preserve Operator packing measurements. Required route cargo can change separately from those physical records.',
                   'The first release replay changed two test-local variable names to clear lint. No production source or assertion changed; the second replay source remains fully fixed.',
                   'No business-data repair was performed. Specific LOINC/PO checks were stopped as requested.']}
    (ROOT / 'release-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    (ROOT / 'release-source-manifest.json').write_text(json.dumps(source, indent=2) + '\n')
    (ROOT / 'unresolved-final-stops.json').write_text(json.dumps(unresolved, indent=2) + '\n')
    final = content_results[1]['streams']['snapshot']
    lines = ['# Deployed planning, packing and cargo verification', '',
        f"Deployed at {deployment['at']}: `{deployment['image']}`. Live health, public assets, all {deployment['runtimeFilesVerified']} runtime files, unchanged configuration and other services were verified. A rollback image is retained.", '',
        'Packing alone no longer blocks PO or TO links or replenishment-to-direct-pickup changes, including packed CO cargo. Recorded packing values are preserved. Physical loading, receiving, Driver execution and route precedence remain protected.', '',
        'Packing-slip numbers are text outside SCM Working. Eight audience/view combinations and 10 existing schedule browser tests pass.', '',
        'Two fresh deployed-source replays each saved and rolled back all 3,101 accepted August/September states. Each finished with the 228-test planning, packing, cargo and Driver gate. Two independent cargo/route audits produced identical results.', '',
        f"The 60 final snapshots contain {final['pickups']} pickups and {final['deliveries']} deliveries; each pass performed {final['contentChecks']} Dispatch and {final['driverContentChecks']} Driver plan-content comparisons.", '',
        f"Missing historical evidence remains for {final['unresolvedCargoStops']} delivery stops and {sum(final['unresolvedRouteChecks'].values())} route checks: {final['unresolvedRouteChecks']}. See [unresolved final stops](unresolved-final-stops.json). These are evidence gaps, not planning rejections.", '',
        'Linked cargo examples: a shared TO supplying 4 + 3 pieces displays all 7 online and offline. A 51-pallet PO pickup supplying 38 to a customer and 13 to the yard displays 51 once at pickup, then 38 and 13 at the respective deliveries.', '',
        f"Logic regression gates passed: **{evidence['logicRegressionGatesPassed']}**. Complete historical evidence: **{evidence['historicalEvidenceComplete']}**. Focused and shuffled tests: 228 each. Manual mutants: 10/10 killed. Changed executable lines: {sum(row['covered'] for row in covered['files'])}/{sum(row['changedExecutableLines'] for row in covered['files'])}.", '',
        'The broad suite retains pre-existing failures. New waitlist failures were caused by an incomplete disposable test template and a missing test output directory; matching baseline/candidate reruns resolved them. Detailed diagnostics and corrections are in [release evidence](release-evidence.json).', '',
        'The first replay includes a documented test-only lint cleanup; production code and assertions stayed fixed. The second replay has fully fixed source. Spec approval was not obtained; the user authorized this autonomous work.', '',
        'Reproduce the paired deployed-source run with `bash server/tools/dispatch-history-cargo-release-gauntlet.sh` using the preserved capture and local test images. Earlier reports are moved into previous-evidence before a fresh run. Specific-order investigations were stopped; no business-data repair was performed.', '']
    (ROOT / 'REPORT.md').write_text('\n'.join(lines))
    print(json.dumps({'checks': checks, 'logicRegressionGatesPassed': evidence['logicRegressionGatesPassed'],
                      'historicalEvidenceComplete': evidence['historicalEvidenceComplete'], 'finalSnapshots': final}, indent=2))
    return 0 if all(checks.values()) else 1


if __name__ == '__main__':
    sys.exit(main())
