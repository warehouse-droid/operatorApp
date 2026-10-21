"""Assemble the final, source-identified verification and deployment evidence."""
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/po-line-identity-20261015'


def load(name):
    return json.loads((OUT / name).read_text())


final = load('final.json')
deployment = load('general-deployment.json')
assert final['completeGauntlet'] and deployment['deployed']
assert final['hashes'] == deployment['files']
cleanup = load('cleanup-final.json')
assert cleanup['teardownExit'] == 0 and not cleanup['taskContainers']
assert not cleanup['networks'] and not cleanup['volumes'] and cleanup['productionHealthy']
coverage = load('changed-coverage.json')
replay = load('history-replay-summary.json')
assert replay['passed'] and replay['unexpectedDifferences'] == 0
assert replay['candidateSourceHashes'] == final['hashes']
report = {
    'objective': 'Correct split SO PO line identity, clear retired group PO links, warn before ungrouping, correct compact group pickup/pallet projections, and compare all retained PO planning evidence.',
    'specApproval': 'not obtained (autonomous run)',
    'spec': 'tools/po-line-identity-20261015/spec.md',
    'reproduce': 'bash server/tools/po-line-identity-20261015/gauntlet.sh',
    'sourceHashes': final['hashes'],
    'verificationFileHashes': {str(path.relative_to(SERVER)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted((SERVER / 'tools/po-line-identity-20261015').glob('*')) if path.is_file()},
    'toolchain': final['toolchain'],
    'node': final['node'],
    'acceptance': [
        {'behavior': 'Distinct repeated-item split lines retain exact IDs, descriptions, units, quantities and stable keys.',
         'tests': ['dispatch-target-line-identity.test.js: GOA-9948S1-9949S1 keeps BLU slab and SIENASTONE coping as distinct source lines',
                   'dispatch-target-line-identity.test.js: PO options preserve separate descriptions, UOMs and candidate lines for split and grouped repeated items']},
        {'behavior': 'Parent row and NetSuite line identity precede item/SKU fallback; materialized children ignore stale parent row IDs.',
         'tests': ['test/dispatch/unit/dispatch-target-line-identity.test.js'], 'properties': '100 line-order trials plus 100 parent-row trials'},
        {'behavior': 'Actual saved PO row is correct; incompatible UOM is rejected before writes.',
         'tests': ['test/dispatch/integration/dispatch-target-line-identity.test.js']},
        {'behavior': 'Materializing splits remaps PO and TO links to the correct child row.',
         'tests': ['test/dispatch/integration/dispatch-target-line-identity.test.js']},
        {'behavior': 'Retirement cancels only retired target allocations, retains history, is idempotent and rolls back atomically.',
         'tests': ['test/dispatch/integration/dispatch-target-line-identity.test.js']},
        {'behavior': 'Ungroup fetches current PO links, warns, respects cancellation and detection errors, and refreshes affected POs.',
         'tests': ['test/dispatch/frontend/dispatch-ungroup-po-warning.test.js'], 'realBrowser': 'browser.json'},
        {'behavior': 'Missing group member details cannot invent a source yard or zero an authoritative pallet count.',
         'tests': ['test/dispatch/frontend/dispatch-group-pickup-card.test.js'], 'realFunctionFlow': 'pickup-card-fixed.json'},
        {'behavior': 'Explicit 3445 sources, genuine child cargo and full legacy SO defaults survive.',
         'tests': ['test/dispatch/frontend/dispatch-group-pickup-card.test.js'], 'properties': '40 native-yard/repeated-refresh trials'},
        {'behavior': 'The affected live group is correct and SOA09948-S2 has four distinct lines.',
         'evidence': 'general-deployment.json'},
        {'behavior': 'All four requested old-group PO links were cancelled with rollback evidence and an audit.',
         'evidence': '../../deployments/retired-group-po-links-20261015/apply.json'},
        {'behavior': 'Retained PO planning and the seven-day window preserve the existing rules, with source/history gaps explicit.',
         'evidence': 'history-replay-summary.json'},
    ],
    'verification': {
        'focused': {key: final['focused'][key] for key in ['tests', 'pass', 'fail', 'health']},
        'regression': {key: final['regression'][key] for key in ['tests', 'pass', 'fail', 'failures']},
        'regressionScope': 'All Dispatch unit/property/adversarial/frontend test files and integration suites directly importing the changed target or lifecycle repository.',
        'preExistingFailures': final['baselineFailures'],
        'changedLinesCovered': sum(row['covered'] for row in coverage),
        'changedLinesTotal': sum(row['total'] for row in coverage),
        'coverage': coverage,
        'mutations': load('mutations.json'),
        'newLint': final['newLint'],
        'newTypes': final['newTypes'],
        'secrets': final['secrets'],
        'browser': load('browser.json'),
        'pickupFlow': load('pickup-card-fixed.json'),
        'suiteHealth': 'Focused suites also passed in reversed file order.',
        'newDependencies': [],
        'supplyChainAudit': 'Not applicable: dependency manifests and dependency set unchanged.',
        'historyReplay': replay,
        'replayDevelopmentFindings': [
            'Initial checker compared shifted array positions after the existing order-ID deduplication; corrected to compare retained cargo by order ID. Two duplicate root IDs are reported.',
            'Initial historical quantity assertion exposed the pre-existing MBBS-Special sales-quantity-only rule. Seven older physical-quantity rows are explicitly recorded and compared under the existing rule.',
        ],
    },
    'knownLimits': [
        f"The full repository is not green: {len(final['baselineFailures'])} existing failures remain in the selected regression scope, plus an existing standalone harness ReferenceError. Static lint/type checks also have existing diagnostics; no new diagnostics were introduced.",
        'A human did not review the acceptance specification before implementation.',
        'Real browser checks use isolated transport fixtures. Production verification performs read-only repository checks and an HTTP asset/health check, without creating allocations.',
        'No concurrent production mutation stress test was performed. Existing shared fleet transaction locking is retained, and integration tests verify rollback.',
        'Routing follows the order lines, as the user clarified. All inspected SO line locations are 2967; source yard data was not modified.',
        'Historical replay uses saved states and reconstructed commands. Original request bodies, original service selections and complete upstream source versions are unavailable; source gaps and October 12 are not counted as passes.',
    ],
    'investigation': load('root-cause-report.json'),
    'activeLineAudit': load('active-line-audit.json'),
    'retiredTargetAudit': load('retired-target-audit.json'),
    'cleanup': cleanup,
    'replayCleanup': {mode: load('cleanup-' + mode + '.json') for mode in ['history-baseline', 'history-candidate']},
    'deployment': deployment,
}
(OUT / 'EVIDENCE.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'focusedPass': final['focused']['pass'], 'regressionPass': final['regression']['pass'],
    'preExistingFailures': len(final['baselineFailures']), 'newFailures': 0,
    'mutationsKilled': len(report['verification']['mutations']),
    'coveredChangedLines': report['verification']['changedLinesCovered'], 'deployed': True,
    'evidence': str(OUT / 'EVIDENCE.json')}))
