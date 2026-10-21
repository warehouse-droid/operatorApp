"""Record scoped source changes and actual final evidence without test databases."""
from pathlib import Path
import difflib
import hashlib
import json
import re

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/transfer-yard-posting-20261021'
FINAL = ARTIFACT / 'final'


def read(name):
    return json.loads((FINAL / name).read_text())


source = read('source.json')
coverage = read('coverage/coverage-final.json')
patches = []
line_report = []
for name, digest in source['hashes'].items():
    current = (SERVER / name).read_text()
    assert hashlib.sha256(current.encode()).hexdigest() == digest, name
    before = (ARTIFACT / 'before' / name).read_text()
    left, right = before.splitlines(True), current.splitlines(True)
    patches.extend(difflib.unified_diff(left, right, fromfile='before/' + name, tofile='after/' + name))
    changed = set()
    for tag, _, _, start, stop in difflib.SequenceMatcher(a=left, b=right).get_opcodes():
        if tag in ('insert', 'replace'):
            changed.update(range(start + 1, stop + 1))
    record = coverage.get('/app/' + name)
    assert record, name
    for number in sorted(changed):
        text = right[number - 1].strip()
        if not text or text.startswith(('//', '/*', '*')):
            continue
        counts = [record['s'][key] for key, span in record['statementMap'].items()
                  if span['start']['line'] <= number <= span['end']['line']]
        if counts:
            line_report.append({'file': name, 'line': number, 'covered': max(counts) > 0})

(ARTIFACT / 'changes.patch').write_text(''.join(patches))
changed_coverage = {'covered': sum(row['covered'] for row in line_report), 'total': len(line_report),
                    'lines': line_report, 'method': 'Changed executable lines covered by c8 statement ranges; SQL text is covered as its executed query statement.'}
(FINAL / 'changed-coverage.json').write_text(json.dumps(changed_coverage, indent=2) + '\n')
assert changed_coverage['covered'] == changed_coverage['total'], [row for row in line_report if not row['covered']]

tests = read('tests.json')
lint = read('lint-comparison.json')
types = read('type-comparison.json')
mutations = read('mutations/results.json')
assert not tests['newFailures'] and not lint['newIssues'] and not types['newIssues']
assert len(mutations) == 5 and all(row['killed'] for row in mutations)
run_log = (FINAL / 'run.log').read_text()
project = re.search(r'mbbs-transfer-yard-test-(\d+)-db-1', run_log).group(1)
cleanup = {}
for kind in ['docker-running', 'docker-all', 'networks', 'volumes', 'production-health']:
    path = ARTIFACT / f'{kind}-{project}.log'
    cleanup[kind] = {'file': str(path.relative_to(SERVER)), 'contents': path.read_text().strip()}
assert not cleanup['networks']['contents'] and not cleanup['volumes']['contents']
for kind in ['docker-running', 'docker-all']:
    assert 'mbbs-transfer-yard-test-' not in cleanup[kind]['contents']
assert cleanup['production-health']['contents'].count(' healthy') == 3
report = {
    'feature': 'Transfer Order IF on loading and IR on receiving without driver completion',
    'specification': 'test/transfer-yard-posting.spec.json',
    'specApproval': 'not obtained (autonomous run)',
    'tier': 3,
    'entryPoint': 'bash server/tools/transfer-yard-posting-gauntlet.sh',
    'source': source,
    'tests': tests,
    'cleanup': cleanup,
    'secretScan': read('secrets.json'),
    'changedLineCoverage': changed_coverage,
    'mutation': mutations,
    'lint': {'baselineIssues': len(lint['baseline']), 'currentIssues': len(lint['current']), 'newIssues': lint['newIssues']},
    'types': types,
    'scenarioTests': {
        'if-on-load': ['transfer-yard-posting: outbound loading posts IF before any receiving or driver work'],
        'ir-on-receipt': ['transfer-yard-posting: each partial receipt posts IR without waiting for the rest of the shipment'],
        'local-receiving': ['transfer-yard-posting: failed IF leaves receiving available; retry posts IF then the saved IR exactly once', 'transfer-order-background-posting: real HTTP saves load and receipt with NetSuite unavailable'],
        'recovery': ['transfer-yard-posting: legacy waiting jobs advance', 'transfer-order-background-posting: independent concurrent workers admit exactly one command', 'transfer-order-background-posting: durable worker success/reject/timeout and uncertain retry cases'],
        'boundary': ['transfer-yard-posting: IR transform rechecks the saved receipt even after admission', 'operator-to-yard-flow properties: quantity coverage, own records and dispatch scope', 'transfer-order-background-posting: source identity/remaining quantity guards'],
        'history': ['movement-document-history: transfer load history no longer waits for its driver drop', 'movement-document-history: existing sales/receipt/document regressions'],
        'compatibility': ['Existing direct-to-completion, linked SO, posting, receiving, history and yard authorization suites; two pre-existing failures retained and reported in tests.json'],
        'consolidation': ['consolidation-load-posting: background TO posting never becomes synchronous in a consolidated load']
    },
    'execution': 'Real disposable PostgreSQL, HTTP routes and durable worker with only the NetSuite network boundary stubbed; direct-to-customer and retry/timeout regressions included.',
    'verificationHistory': ['The baseline initially symlinked reconciliation tools into the current source tree; the baseline now copies top-level tools so all database transaction contexts belong to the same staged tree.', 'Reverse-order testing caught a test fixture choosing the previous partial receipt when transaction timestamps tied and UUIDs sorted randomly. The fixture now selects the monotonic Operator record ID; all quantity assertions are unchanged.', 'The full-project type run was removed with registered cleanup at the existing memory ceiling; final checks use the changed module graph.'],
    'suiteHealth': 'Same complete affected suite rerun in reverse file order with identical counts and failures.',
    'limits': [
        'No production deployment or live NetSuite writes were performed.',
        'The full repository type check reached the 2 GiB test-container memory ceiling and was stopped. The final type comparison checks all eight changed modules and their imported module graph, using the existing compiler settings.',
        'The affected suite retains two unrelated baseline failures: outbound TO visibility with a NetSuite Received header, and an authorized saved-orders endpoint returning 500. No new failures are accepted.',
        'No browser layout changed. History behavior is verified through its database/API evidence projection and existing history tests; a new visual browser test was not added.',
        'No new dependencies or schema migrations. Dependency/license audits and migration rollback rehearsal were not rerun.',
        'No Git commits were created in the shared dirty workspace. Original scoped sources, the patch and SHA-256 hashes are retained.',
        'Existing direct-to-customer transfers retain linked Sales Order driver evidence because they do not have an inbound-yard receipt.'
    ]
}
(ARTIFACT / 'evidence-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'report': str(ARTIFACT / 'evidence-report.json'), 'tests': tests['current'],
                  'coverage': f"{changed_coverage['covered']}/{changed_coverage['total']}", 'mutantsKilled': len(mutations)}))
