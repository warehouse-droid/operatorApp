"""Compare both real-code replays and fail on any unexplained rule change."""
from collections import Counter
import hashlib
import json
from pathlib import Path

TASK = Path(__file__).resolve().parent
OUT = TASK.parents[1] / 'test-artifacts/po-line-identity-20261015'
load = lambda name: json.loads((OUT / name).read_text())
baseline, candidate = load('history-baseline.json'), load('history-candidate.json')
capture = load('runtime-capture.json')
fixture = load('history-capture.json')
assert baseline['complete'] and candidate['complete']
assert baseline['fixtureSha256'] == candidate['fixtureSha256'] == fixture['sha256']
assert baseline['sourceHashes'] == capture['before']
assert candidate['sourceHashes'] == capture['after']
for result in [baseline, candidate]:
    assert len(result['states']) == fixture['counts']['state']
    assert len(result['allocations']) == fixture['counts']['allocation']
    assert len(result['receipts']) == fixture['counts']['receipt']
for filename, expected in capture['after'].items():
    assert hashlib.sha256((OUT / 'candidate' / filename).read_bytes()).hexdigest() == expected

unexpected, corrections = [], []
index = lambda rows, field: {row[field]: row for row in rows}
states_before, states_after = index(baseline['states'], 'key'), index(candidate['states'], 'key')
assert states_before.keys() == states_after.keys()
window = {f'2026-10-{day:02}': {'history': 0, 'current': 0, 'orders': 0,
    'currentStatesWithRuleConflicts': 0} for day in range(8, 15)}
state_counts = Counter()
for key, after in states_after.items():
    before = states_before[key]
    state_counts[key.split(':')[0]] += 1
    state_counts['orders'] += after['orderCount']
    state_counts['ordersWithPoEvidence'] += after['poOrders']
    state_counts['duplicateRootIdsInRetainedInput'] += after['duplicateRootIds']
    state_counts['rejectedRecoveryDrafts'] += bool(after['rejectedRecovery'])
    state_counts['archivedStatesNotMarkedRejected'] += key.startswith('history:') and not after['rejectedRecovery']
    state_counts['currentStatesWithRuleConflicts'] += key.startswith('current:') and after['rawRules']['count'] > 0
    state_counts['retainedStatesWithRuleConflicts'] += after['rawRules']['count'] > 0
    state_counts['retainedStatesWithProjectionDifferences'] += not after['projection']['equal']
    if after['planDate'] in window:
        day = window[after['planDate']]
        day[key.split(':')[0]] += 1
        day['orders'] += after['orderCount']
        day['currentStatesWithRuleConflicts'] += key.startswith('current:') and after['rawRules']['count'] > 0
    for field in ['projection', 'rawRules', 'refreshedRules']:
        if before[field] != after[field]:
            unexpected.append({'case': key, 'field': field, 'before': before[field], 'after': after[field]})
    # Full refresh may remove a yard invented for an unhydrated child. The
    # original route validator remains unchanged; compare retained route rules
    # separately from this intentional browser-state correction.
    for path in ['full', 'compact']:
        before_orders, after_orders = index(before[path], 'ref'), index(after[path], 'ref')
        inputs = index(after['input'], 'ref')
        assert before_orders.keys() == after_orders.keys()
        for ref, new in after_orders.items():
            old, original = before_orders[ref], inputs[ref]
            if old == new:
                continue
            reasons = []
            for field in ['ref', 'type', 'cargo']:
                if old[field] != new[field]:
                    unexpected.append({'case': key, 'path': path, 'ref': ref, 'field': field})
            if old['source'] != new['source']:
                if old['source'] == '3445' and new['source'] == '' and not original['source']:
                    reasons.append('unknown source retained instead of defaulting compact SO to 3445')
                else:
                    unexpected.append({'case': key, 'path': path, 'ref': ref, 'field': 'source', 'before': old, 'after': new})
            if old['pallets'] != new['pallets']:
                if original['childRefs'] and new['pallets'] == original['pallets']:
                    reasons.append('authoritative group pallet count retained for missing member details')
                else:
                    unexpected.append({'case': key, 'path': path, 'ref': ref, 'field': 'pallets', 'before': old, 'after': new})
            if old['pickups'] != new['pickups']:
                removed = set(old['pickups']) - set(new['pickups'])
                added = set(new['pickups']) - set(old['pickups'])
                if original['childRefs'] and removed == {'3445'} and not added:
                    reasons.append('phantom 3445 pickup removed from missing group-member placeholders')
                else:
                    unexpected.append({'case': key, 'path': path, 'ref': ref, 'field': 'pickups', 'before': old, 'after': new})
            if old['children'] != new['children']:
                old_children = {row[0]: row[1:] for row in old['children']}
                new_children = {row[0]: row[1:] for row in new['children']}
                original_sources = dict(original['childSources']) if path == 'full' else {}
                if old_children.keys() != new_children.keys():
                    unexpected.append({'case': key, 'path': path, 'ref': ref, 'field': 'child membership'})
                for child_ref, values in new_children.items():
                    previous = old_children.get(child_ref)
                    if previous == values:
                        continue
                    if previous == ['3445', values[1]] and values[0] == '' and not original_sources.get(child_ref):
                        reasons.append('unhydrated child source remains unknown')
                    else:
                        unexpected.append({'case': key, 'path': path, 'ref': ref, 'field': 'child source/pallets',
                            'child': child_ref, 'before': previous, 'after': values})
            if reasons:
                corrections.append({'case': key, 'path': path, 'ref': ref, 'reasons': sorted(set(reasons))})
allocation_before, allocation_after = index(baseline['allocations'], 'id'), index(candidate['allocations'], 'id')
assert allocation_before.keys() == allocation_after.keys()
allocation_counts = Counter()
allocation_gaps = []
for key, after in allocation_after.items():
    before = allocation_before[key]
    allocation_counts[after['kind']] += 1
    allocation_counts[after['status']] += 1
    if before['status'] == 'replayed' and after['status'] != 'replayed':
        unexpected.append({'case': f'allocation:{key}', 'before': before, 'after': after})
    if after['status'] != 'replayed':
        allocation_gaps.append({'id': key, 'targetRef': after['targetRef'], 'reason': after['message'],
            'baselineSame': before.get('message') == after['message']})
        if before.get('message') != after['message']:
            unexpected.append({'case': f'allocation:{key}', 'before': before, 'after': after})
        continue
    identity = after['identity']
    allocation_counts['historicalSpecialPhysicalNormalizations'] += identity['historicalSpecialPhysicalNormalization']
    for original, actual in [('originalSalesLineId', 'actualSalesLineId'), ('originalUnit', 'actualUnit'),
        ('originalDescription', 'actualDescription')]:
        if identity[original] != identity[actual]:
            unexpected.append({'case': f'allocation:{key}', 'field': actual, 'identity': identity})
    if before['status'] == 'replayed' and before['identity'] != identity:
        previous = before['identity']
        if previous['quantity'] != identity['quantity'] or previous['actualTargetKey'] != identity['actualTargetKey']:
            unexpected.append({'case': f'allocation:{key}', 'field': 'quantity or stable target key', 'before': previous, 'after': identity})
        else:
            corrections.append({'case': f'allocation:{key}', 'reasons': ['exact source identity restored']})
    if after['knownDerivedDefinition']:
        allocation_counts['retiredTargetCleanupReplayed'] += 1
        if after['retirementStatus'] != 'cancelled' or after['activeSalesQtyAfterRetirement'] != 0:
            unexpected.append({'case': f'allocation:{key}', 'field': 'retirement', 'after': after})
        if before.get('retirementStatus') == 'active':
            allocation_counts['baselineOrphansPrevented'] += 1
    elif after['retirementStatus'] != 'active':
        unexpected.append({'case': f'allocation:{key}', 'field': 'normal allocation was cancelled', 'after': after})

receipt_before, receipt_after = index(baseline['receipts'], 'requestId'), index(candidate['receipts'], 'requestId')
assert receipt_before.keys() == receipt_after.keys()
receipt_counts, receipt_gaps = Counter(), []
for key, after in receipt_after.items():
    before = receipt_before[key]
    receipt_counts[after['action']] += 1
    receipt_counts[after['action'] + ':' + after['status']] += 1
    receipt_counts['preMaterializationReceiptsReplayed'] += bool(after.get('originalParentContext'))
    if before != after:
        unexpected.append({'case': f'receipt:{key}', 'before': before, 'after': after})
    if after['status'] != 'replayed':
        receipt_gaps.append({'requestId': key, 'action': after['action'], 'reason': after['message']})

target_before, target_after = index(baseline['derivedTargets'], 'hash'), index(candidate['derivedTargets'], 'hash')
assert target_before.keys() == target_after.keys()
target_gaps = []
for key, after in target_after.items():
    before = target_before[key]
    if before != after:
        unexpected.append({'case': f'derived-target:{key}', 'before': before, 'after': after})
    if after['status'] != 'replayed':
        target_gaps.append({'targetRef': after['targetRef'], 'sourceState': after['sourceState'], 'reason': after['message']})

reasons = Counter(reason for correction in corrections for reason in correction['reasons'])
dataset = candidate['retirementDataset']
assert dataset['count'] == fixture['counts']['allocation']
assert dataset['before'] == baseline['retirementDataset']['before']
all_after = index(dataset['after'], 'id')
dataset_cancellations = 0
for row in dataset['before']:
    expected_status = 'cancelled' if row['targetRef'] in dataset['retiredTargets'] else row['status']
    if all_after[row['id']]['status'] != expected_status:
        unexpected.append({'case': 'retirement-dataset:' + row['id'], 'expectedStatus': expected_status,
            'actual': all_after[row['id']]})
    dataset_cancellations += row['status'] == 'active' and expected_status == 'cancelled'
summary = {'passed': not unexpected, 'fixtureSha256': fixture['sha256'],
    'capturedAt': candidate['capture']['capturedAt'], 'window': candidate['capture']['window'],
    'baselineSourceHashes': baseline['sourceHashes'], 'candidateSourceHashes': candidate['sourceHashes'],
    'planningStates': dict(state_counts), 'sevenDayWindow': window,
    'allocations': dict(allocation_counts), 'receipts': dict(receipt_counts),
    'derivedTargetVariants': len(target_after), 'derivedTargetsReplayed': len(target_after) - len(target_gaps),
    'wholeAllocationRetirementReplay': {'rows': dataset['count'], 'activeDerivedLinksCancelled': dataset_cancellations,
        'historyAndQuantitiesPreserved': True},
    'expectedBrowserCorrections': dict(reasons), 'unexpectedDifferences': len(unexpected),
    'gaps': {'allocationSourceVersions': allocation_gaps, 'receiptSourceVersions': receipt_gaps,
        'derivedTargetSourceVersions': target_gaps, 'datesWithNoRetainedPlan': [day for day, value in window.items()
            if value['history'] + value['current'] == 0]},
    'assumptions': candidate['assumptions'],
    'scope': 'Saved-state rule replay plus reconstructed allocation/material-batch commands; original full requests and original upstream snapshots are unavailable.'}
(OUT / 'history-comparison-details.json').write_text(json.dumps({'corrections': corrections, 'unexpected': unexpected}, indent=2) + '\n')
(OUT / 'history-replay-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({key: value for key, value in summary.items() if key not in ['gaps', 'assumptions']}, indent=2), flush=True)
assert not unexpected, f'{len(unexpected)} unexplained replay differences; see history-comparison-details.json'
