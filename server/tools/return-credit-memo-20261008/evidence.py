"""Summarize final logs and source-mapped coverage without rerunning workloads."""
import difflib
import hashlib
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/return-credit-memo-20261008'
TASK = SERVER / 'tools/return-credit-memo-20261008'
files = json.loads((TASK / 'files.json').read_text())
state = json.loads((OUT / 'source-state.json').read_text())
for file in files:
    assert hashlib.sha256((SERVER / file).read_bytes()).hexdigest() == state['sources'][file], 'Source changed after final tests: ' + file

def scoped(file, line, lines):
    if file == 'src/mbt/feature-gate-catalog.js':
        return 'OPERATOR_NETSUITE_RETURN_CREDIT_MEMO_GATE_DEFINITIONS' in lines[line - 1] or '...[...OPERATOR_NETSUITE_GATE_DEFINITIONS' in lines[line - 1]
    if file == 'public/service-worker.js':
        return lines[line - 1].startswith('const CACHE_NAME') or '/operator.js?v=' in lines[line - 1]
    scopes = {'src/server.js': ['operatorSafeReturnPayload'], 'public/operator.js':
              ['returnNetSuiteResultLabel', 'renderReturnSuccess', 'renderReturnPostingPolicies']}
    if file not in scopes:
        return True
    for name in scopes[file]:
        first = next(i for i, text in enumerate(lines, 1) if text.startswith('function ' + name + '('))
        end = next((i for i, text in enumerate(lines, 1) if i > first and re.match(r'^(async )?function ', text)), len(lines) + 1)
        if first <= line < end:
            return True
    return False

node_coverage = json.loads((OUT / 'coverage/coverage-final.json').read_text())
browser_coverage = json.loads((OUT / 'browser-v8.json').read_text())
coverage = {}
changes = {}
for file in files:
    current = (SERVER / file).read_text()
    lines = current.splitlines()
    original = OUT / 'baseline' / file
    before = original.read_text().splitlines() if original.exists() else []
    changed = set()
    for tag, _i, _j, start, end in difflib.SequenceMatcher(None, before, lines, autojunk=False).get_opcodes():
        if tag != 'equal':
            changed.update(range(start + 1, end + 1))
    changed = {line for line in changed if scoped(file, line, lines)}
    changes[file] = sorted(changed)
    if not file.endswith('.js'):
        continue
    counted = {line for line in changed if lines[line - 1].strip() and not lines[line - 1].strip().startswith(('//', '/**', '*'))}
    hits = set()
    entry = node_coverage.get('/app/' + file)
    if entry:
        for key, span in entry['statementMap'].items():
            if entry['s'][key] > 0:
                hits.update(range(span['start']['line'], span['end']['line'] + 1))
    for entry in browser_coverage:
        if not entry['url'].endswith('/' + file):
            continue
        # Padded browser scripts retain original character offsets.
        ranges = [span for function in entry['functions'] for span in function['ranges']]
        padded = entry['source'].encode('utf-16-le')
        offset = 0
        for number, line in enumerate(current.splitlines(keepends=True), 1):
            first = offset + len(line) - len(line.lstrip())
            present = padded[first * 2:first * 2 + 2].decode('utf-16-le', errors='replace').strip()
            enclosing = [span for span in ranges if span['startOffset'] <= first < span['endOffset']]
            if line.strip() and present and enclosing:
                smallest = min(enclosing, key=lambda span: span['endOffset'] - span['startOffset'])
                if smallest['count'] > 0:
                    hits.add(number)
            offset += len(line.encode('utf-16-le')) // 2
    coverage[file] = {'changedNonCommentLines': len(counted), 'covered': len(counted & hits), 'uncovered': sorted(counted - hits)}

def counts(path):
    log = path.read_text()
    return {key: sum(int(value) for value in re.findall(r'^(?:#|ℹ) ' + key + r' (\d+)$', log, re.M))
            for key in ['tests', 'pass', 'fail', 'skipped']}

regression = counts(OUT / 'final-regression.log')
assert regression['fail'] == 0 and regression['pass'] > 0
mutations = json.loads((OUT / 'mutations.json').read_text())
assert len(mutations) == 6 and all(row['killed'] for row in mutations)
assert json.loads((OUT / 'lint-new.json').read_text()) == []
cleanup = json.loads((OUT / 'final-cleanup.json').read_text())
assert not any(cleanup[key] for key in ['containers', 'networks', 'volumes']) and cleanup['productionHealthy']
backend = {file: entry for file, entry in coverage.items() if file.startswith('src/')}
report = {
    'feature': 'Direct Operator return Credit Memo gates', 'tier': 3,
    'spec': 'server/test/return-credit-memo-spec.json', 'specApproval': 'not obtained (autonomous run); user explicitly selected direct Credit Memo creation',
    'reproduce': 'python3 server/tools/return-credit-memo-20261008/verify.py',
    'sourceState': state,
    'regression': regression,
    'coverageTestRun': counts(OUT / 'coverage-tests.log'),
    'changedSourceCoverage': coverage,
    'backendChangedLines': sum(row['changedNonCommentLines'] for row in backend.values()),
    'backendCoveredChangedLines': sum(row['covered'] for row in backend.values()),
    'newCreditMemoModuleCoverage': json.loads((OUT / 'coverage/coverage-summary.json').read_text())['/app/src/return-credit-memo.js'],
    'mutations': mutations,
    'browser': json.loads((OUT / 'browser.json').read_text()),
    'audit': json.loads((OUT / 'audit.json').read_text()),
    'static': {'newLintDiagnostics': 0, 'strictDomainTypecheck': 'passed', 'runtimeJavaScriptSyntax': 'passed'},
    'scenarioMapping': {
        'G1/G2': 'return-credit-memo unit/integration tests; posting policy regression; feature-gate admin HTTP regression',
        'P1/P2': 'stock/pallet/combined POST contracts, split reasons, generated price/quantity invariants and incompatible/disabled component integration tests',
        'V1': 'generated and adversarial snapshot verification; failed draft integration',
        'R1': '12 simultaneous retries, lost response, outer rollback, definite rejection, existing RA intent and immutable-intent integration tests',
        'Q1': 'CM pallet external-ID/transaction-ID deduplication and stock source reservation integration test; existing RA quota regressions',
        'L1': 'manual link mismatch, changed decision, reconciliation and void tests',
        'U1': 'real authenticated HTTP submission/privacy test, personal history test, browser checks at 390/1280px, Admin matrix and Control/Sales labels'
    },
    'failuresResolved': [
        'All 20 initial acceptance tests failed before implementation.',
        'Preserved the original local stage for unposted RA admissions after a legacy recovery regression failed.',
        'Corrected the test expectation for an existing direct-access ceiling: it blocks return lookup, not only posting.',
        'Corrected a history test fixture expectation from an object to the existing array response; the history omission mutation independently verifies the assertion.',
        'A wrong manual link had changed a previously verified batch to failed; now it preserves the verified state and remains eligible for reconciliation.',
        'An exploratory removal of the uncertain-create precheck survived because the atomic attempt marker independently blocked a second create. The final mutation instead resets that marker after an ambiguous failure and is killed.'
    ],
    'knownLimits': [
        'The broad pre-change npm test baseline stalled at file 477/900, aggregate-request-browser.test.js, repeatedly reporting SPECIAL_STOCK_DISABLED. It was terminated and its disposable environment removed. Full-project regression confidence is unverified; the complete selected return/gate regression group passes.',
        'Live NetSuite calls are mocked at HTTP boundaries. No live credit or production gate activation was performed. Deployment status is recorded under rollout.',
        'HTML asset version strings and static guidance copy are checked by syntax/assets/browser checks rather than execution coverage. Other uncovered lines are listed explicitly above.',
        'No new dependencies were introduced; dependency audit/license revalidation skipped. Broad repository type checking was not repeated; strict checking covers the new CM domain and the affected policy/batch domain.',
        'Unrelated concurrent Operator phone edits in shared files are excluded from task-only changed-line coverage and lint comparison; full source hashes identify the actual tested source.'
    ],
    'apiContractSource': 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0404042133.html',
    'cleanup': {'taskContainers': 0, 'taskNetworks': 0, 'taskVolumes': 0, 'productionHealthy': True},
    'rollout': {'deployed': False, 'gatesDefaultEnabled': False,
        'flags': ['operator_netsuite_' + kind + '_return_cm_' + yard for yard in ['3445', '2967', '12441', '150'] for kind in ['stock', 'pallet']],
        'behavior': 'For new submissions, enabled CM gates override RA gates. Both component modes must match for a combined NetSuite posting. Existing admitted intents retain their original type.'}
}
release = SERVER / 'deployments/return-credit-memo-20261008'
if (release / 'deployment-result.json').exists():
    deployment = json.loads((release / 'deployment-result.json').read_text())
    assert deployment['deployed'] and deployment['creditMemoGatesEnabled'] is False
    report['rollout'].update({'deployed': True, 'gatesCurrentlyEnabled': False,
        'deploymentEvidence': str(release / 'deployment-result.json'),
        'candidateTreeHash': deployment['candidateTreeHash'], 'deployedAt': deployment['at']})
    report['deploymentValidation'] = json.loads((release / 'validation-passed.json').read_text())
(OUT / 'changed-lines.json').write_text(json.dumps(changes, indent=2))
(OUT / 'evidence.json').write_text(json.dumps(report, indent=2))
print(json.dumps({'regression': regression, 'mutantsKilled': len(mutations), 'backendCoverage': [report['backendCoveredChangedLines'], report['backendChangedLines']], 'evidence': str(OUT / 'evidence.json')}))
