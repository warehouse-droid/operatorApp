"""Collect the saved final-run evidence without regenerating or inventing results."""
from pathlib import Path
import hashlib
import json
import re

server = Path(__file__).resolve().parents[1]
release = server / 'deployments/already-ordered-arrival-20261020'
folder = release / 'validation-artifacts/already-ordered-arrival-20261020'
load = lambda path: json.loads(path.read_text())
static = load(folder / 'static.json')
coverage = load(folder / 'changed-line-coverage.json')
manifest = load(release / 'manifest.json')
tests = []
for name in ['full.log', 'regressions.log']:
    log = (folder / name).read_text()
    counts = {key: int(re.findall(r'^# ' + key + r' (\d+)$', log, re.M)[-1]) for key in ['tests', 'pass', 'fail', 'skipped']}
    assert counts['fail'] == counts['skipped'] == 0 and counts['pass'] == counts['tests']
    tests.append({'log': str(folder / name), **counts})
assert all(static['hashes'][name] == manifest['candidateTree'][name] for name in manifest['files'])
assert (release / 'validation-cleanup-passed').exists()
deployment = load(release / 'deployment-result.json')
assert deployment['deployed']
rows = [json.loads(line) for line in (release / 'completed-request-readback.jsonl').read_text().splitlines()]
assert all(row['statusSummary']['status'] == 'completed' for row in rows if 'statusSummary' in row)
evidence = {
    'spec approval': 'not obtained (autonomous run)',
    'spec': str(server / 'test/already-ordered-arrival-spec.json'),
    'sourceTreeHash': manifest['candidateTreeHash'],
    'runtimeFiles': manifest['files'],
    'commands': {
        'workspace': 'bash server/tools/already-ordered-arrival-check.sh full',
        'releaseValidation': 'sudo -n bash server/tools/already-ordered-arrival-release-check.sh',
        'release': 'sudo -n python3 server/tools/already-ordered-arrival-release.py prepare|validated|build|apply|verify',
        'evidence': 'python3 server/tools/already-ordered-arrival-evidence.py'
    },
    'tests': tests,
    'acceptanceMapping': {
        'SO reference replaces quotation, remains optional, preserves Completed and original quotation': ['SO reference replaces quotation', 'Already Ordered tracks its attached PO before Sales enters', 'Sales replaces the quotation with an SO on mobile'],
        'fully received only; partial, cancelled, unknown, duplicate PO references remain waiting': ['arrival requires a full receipt', 'generated receipt totals', 'NetSuite prefixed PO labels', 'only active receivable PO materials', 'unknown or ambiguous PO references'],
        'scoped persistent arrival alerts, multiple POs and previous reads': ['receipt alerts survive an earlier read', 'receipt acknowledgements validate displayed keys', 'arrival notices remain available alongside a Sales input action'],
        'authorization, stale writes, concurrent saves and canonical SO protection': ['SO attachment enforces role', 'a linked canonical SO cannot be replaced'],
        'read-only projections and backward compatible migration rollback': ['canonical receipt quantities drive arrival', 'additive arrival-read migration'],
        'desktop/mobile display, receipt popup, navigation and acknowledgement': ['Sales replaces the quotation with an SO on mobile', 'a full PO receipt alerts Sales after an earlier read'],
        'existing corrected requests remain Completed': str(release / 'completed-request-readback.jsonl')
    },
    'static': {
        'syntaxFiles': len(static['syntax']),
        'newLintDiagnostics': sum(len(row['added']) for row in static['lint']),
        'typeCheck': static['types'],
        'typeScope': ['public/regular-stock-status.js', 'src/backorder-arrival-status.js', 'src/backorder-arrival.js'],
        'secretFindings': len(static['secrets']),
        'mutations': static['mutations'],
        'versions': static['versions']
    },
    'changedLineCoverage': {'executed': sum(row.get('covered', 0) for row in coverage),
                            'executable': sum(row.get('changedExecutable', 0) for row in coverage),
                            'files': coverage},
    'legacyBaseline': load(folder / 'baseline-comparison.json'),
    'migration': load(release / 'migration-result.json'),
    'review': {
        'capabilityChanges': 'One local Sales-only revision-checked SO reference action, read-only PO receipt projections, and an independent scoped receipt acknowledgement. Existing in-app notifications poll the local NetSuite mirror; no remote order writes or new credentials.',
        'dependencies': 'No dependency or lockfile changes; no packages installed and no new dependency audit required.',
        'failuresResolved': ['An edit to a running test wrapper caused a trailing shell error after all checks finished. The wrapper was then frozen and a clean full exact-candidate rerun was required.',
                             'Behavioral RED runs reproduced missing SO attachment, receipt classification, independent waiting filters, missing mobile form and missing arrival popup.',
                             'A fixture incorrectly used a foreign role as a URL segment; corrected to the actual Sales route before implementing authorization.',
                             'Root cleanup did not have rg on PATH; used portable grep and reran the scoped static/cleanup check with verified production health. Runtime test results were unchanged.',
                             'Static types identified untyped query callbacks and an optional array result; corrected annotations and indexing.',
                             'Live read-only aggregate checks exposed Purchase Order prefixes and inactive removed lines; added failing scenarios before correcting receipt classification.',
                             'An older UI property required quotation fields on every terminal request; updated its contract to the explicitly requested SO replacement while retaining canonical-link and closed-request restrictions.'],
        'limits': ['Targeted regular-stock and Backorder suites, not the entire repository test suite.',
                   'Eight pre-existing legacy assertions fail on both the captured production baseline and this release; baseline comparison requires the same test locations and assertion sites and zero new failures.',
                   'Chromium desktop/mobile viewport coverage; other browser engines unverified.',
                   'Receipt timing depends on normal NetSuite mirror updates and the existing 30-second in-app alert poll.',
                   'No full-repository format/type gate or performance benchmark; syntax, scoped types, differential lint and secrets were checked.',
                   'No new approval for the complete executable spec; only the full-receipt choice was explicitly confirmed.',
                   'Generated properties plus repeated exact-candidate validation; database integration suites run serially for fixture isolation.']
    },
    'deployment': deployment,
    'requests': rows,
    'cleanup': {'verified': True, 'containers': (folder / 'docker-all-full.log').read_text().splitlines(),
                'volumesRemoved': not (folder / 'volumes-full.log').read_text().strip(),
                'networksRemoved': not (folder / 'networks-full.log').read_text().strip(),
                'production': (folder / 'production-health-full.log').read_text().splitlines()},
    'sourceAndEvidenceHash': hashlib.sha256(json.dumps(static['hashes'], sort_keys=True).encode()).hexdigest()
}
target = server / 'artifacts/already-ordered-arrival-20261020/evidence.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(evidence, indent=2) + '\n')
print(json.dumps({'evidence': str(target), 'testsPassed': sum(row['pass'] for row in tests),
                  'changedLinesCovered': evidence['changedLineCoverage']['executed'],
                  'changedLinesExecutable': evidence['changedLineCoverage']['executable']}))
