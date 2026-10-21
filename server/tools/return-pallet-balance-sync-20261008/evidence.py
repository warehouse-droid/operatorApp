"""Summarize preserved check logs and source-mapped coverage for this correction."""
import difflib
import hashlib
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/return-pallet-balance-sync-20261008'
RELEASE = SERVER / 'deployments/return-pallet-balance-sync-20261008'
TASK = SERVER / 'tools/return-pallet-balance-sync-20261008'
state = json.loads((OUT / 'source-state.json').read_text())
coverage = json.loads((OUT / 'coverage/coverage-final.json').read_text())
changed = {}
for name, expected in state['sources'].items():
    assert hashlib.sha256((SERVER / name).read_bytes()).hexdigest() == expected
    before = (OUT / 'baseline' / name).read_text().splitlines()
    after = (SERVER / name).read_text().splitlines()
    lines = set()
    for tag, _, _, start, end in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
        if tag != 'equal':
            lines.update(number for number in range(start + 1, end + 1)
                         if after[number - 1].strip() and not after[number - 1].strip().startswith(('//', '/**', '*')))
    entry = coverage['/app/' + name]
    hits = set()
    for key, span in entry['statementMap'].items():
        if entry['s'][key] > 0:
            hits.update(range(span['start']['line'], span['end']['line'] + 1))
    changed[name] = {'changed': len(lines), 'covered': len(lines & hits), 'uncovered': sorted(lines - hits)}

def counts(name):
    log = (OUT / name).read_text()
    return {key: sum(int(n) for n in re.findall(r'^(?:#|ℹ) ' + key + r' (\d+)$', log, re.M))
            for key in ['tests', 'pass', 'fail', 'skipped']}

regression = counts('final-regression.log')
assert regression == {'tests': 151, 'pass': 151, 'fail': 0, 'skipped': 0}
mutants = json.loads((OUT / 'mutations.json').read_text())
assert len(mutants) == 6 and all(row['killed'] for row in mutants)
assert json.loads((OUT / 'lint-new.json').read_text()) == []
cleanup = json.loads((OUT / 'final-cleanup.json').read_text())
assert cleanup['productionHealthy'] and not any(cleanup[k] for k in ['containers', 'networks', 'volumes'])
report = {'feature':'Fresh pallet balances and confirmed Credit Memo deletion recovery', 'tier':3,
    'spec':'server/test/return-pallet-balance-sync-spec.json', 'specApproval':'not obtained (autonomous run)',
    'sourceState':state, 'regression':regression, 'red':counts('red-checks.log'),
    'coverageTestRun':counts('coverage-tests.log'), 'changedLineCoverage':changed,
    'mutations':mutants, 'static':{'newLintErrors':0,'runtimeSyntax':'passed','existingReturnDomainStrictTypes':'passed'},
    'audit':json.loads((OUT / 'audit.json').read_text()),
    'realExecution':'Authenticated Operator HTTP enquiry confirms fresh balance, deletion recovery, no-store, yard restriction and anonymous denial; NetSuite mocked at HTTP boundary.',
    'reproduce':'python3 server/tools/return-pallet-balance-sync-20261008/verify.py',
    'failuresResolved':['Six of ten initial regressions reproduced current faulty behavior; four preserved behaviors were subsequently checked with targeted mutants.',
                        'The initial green behavior run exposed two new complexity lint violations. Extracted error classification and terminal-state predicates without changing test assertions.'],
    'knownLimits':['Broad pre-change project baseline previously stalled at aggregate-request-browser.test.js (477/900). The complete selected return/gate group passes; full-project confidence is unverified.',
        'No new dependency: audit and license revalidation skipped. Changed legacy repository/NetSuite files are not strict TypeScript modules; syntax, baseline-differential lint and HTTP/integration checks cover these changes. Existing typed return domains still pass strict checking.',
        'No visual changes; browser screenshot rerun is unnecessary. Authenticated HTTP exercises the changed user flow.',
        'NetSuite reads and local admission cannot be one distributed transaction. Submission refreshes remote balance and preserves local reservation locks.',
        'Previously unverified or local-only returns are not released merely because they are absent remotely. Unexplained edits or ambiguous errors fail closed.'],
    'reference':'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156570709583.html',
    'cleanup':{'taskContainers':0,'taskVolumes':0,'taskNetworks':0,'productionHealthy':True}}
if (RELEASE / 'deployment-result.json').exists():
    report['deployment'] = json.loads((RELEASE / 'deployment-result.json').read_text())
    report['deploymentValidation'] = json.loads((RELEASE / 'validation-passed.json').read_text())
if (RELEASE / 'live-balance-after.json').exists():
    report['sampleCustomerVerification'] = json.loads((RELEASE / 'live-balance-after.json').read_text())
(OUT / 'evidence.json').write_text(json.dumps(report, indent=2))
print(json.dumps({'regression':regression,'mutantsKilled':len(mutants),'changedLines':sum(v['changed'] for v in changed.values()),
                  'coveredLines':sum(v['covered'] for v in changed.values()),'uncovered':{k:v['uncovered'] for k,v in changed.items() if v['uncovered']}}))
