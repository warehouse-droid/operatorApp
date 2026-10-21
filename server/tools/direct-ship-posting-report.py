"""Build a reviewable report from independent live verification; no external I/O."""
import csv
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/direct-ship-posting-20261001'
verification = json.loads((OUT / 'live-verification.json').read_text())
retry = json.loads((OUT / 'live-retry.json').read_text())
reconciliation = json.loads((OUT / 'live-reconciliation.json').read_text())
assert verification['readOnly'] and verification['summary']['completedCandidatesChecked'] == 512
assert verification['summary']['verifiedNewFulfillments'] == 3
assert verification['summary']['verifiedNewReceipts'] == 2
assert verification['summary']['remainingGateDisabled'] == 0

fields = ['order_ref', 'parent_id', 'parent_ref', 'outcome', 'candidate_status',
          'live_status', 'live_status_text', 'transaction_id', 'transaction_ref',
          'posting_attempts', 'reason', 'candidate_id']
with (OUT / 'completed-order-results.csv').open('w', newline='') as output:
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    for row in verification['fulfillments']:
        outcome = 'posted_if' if row['netsuite_transaction_id'] else (
            'reconciled_no_post' if row['status'] in ('reconciled', 'closed') else 'held')
        writer.writerow(dict(zip(fields, [
            row['dispatch_order_ref'], row['sourceOrderId'], row['liveHeader']['tranid'],
            outcome, row['status'], row['liveHeader']['status'],
            row['liveHeader'].get('status_text', ''), row['netsuite_transaction_id'],
            row['netsuite_transaction_ref'], row['attempt_count'], row['last_error'] or '', row['id']
        ])))

lines = [
    '# Direct-ship posting fix and completed-order retry', '',
    f"Verified at {verification['verifiedAt']} against live NetSuite and local posting records.", '',
    'The fix is deployed as `mbbs-operator-app:direct-ship-posting-20261001`. MBBS-Special Order lines now participate in Dispatch fulfillment. Verified direct-PO delivery completion creates a durable receipt job using the existing receiving gates and NetSuite posting worker.', '',
    'Live completed/closed order headers prevent a new posting. Open orders are checked for exact line identity, item, yard, and positive remaining quantity immediately before the transform. Existing external-ID recovery and quantity limits remain in use.', '',
    'All 512 locally completed `gate_disabled` SO candidates were checked: **502 reconciled without a new IF**, **3 new IFs verified**, and **7 held**. All four approved gates are enabled; no effective completed candidate remains `gate_disabled`. Seven direct-PO completion events were also checked: two new IRs and five already-complete skips.', '',
    '## Verified new transactions', '',
    '| Local order | NetSuite parent | Type | Transaction | Verified native quantities |',
    '|---|---|---|---|---|',
]
for transaction in verification['verifiedTransactions']:
    quantities = []
    for line in transaction['lines']:
        source = next(source for source in transaction['liveOrder']['lines']
                      if int(source['order_line_number']) == line['orderLine'])
        quantities.append(f"{line['quantity']:g} {source.get('unit', '')} {source['item_name']}")
    lines.append(f"| {transaction['orderRef']} | {transaction['liveOrder']['tranid']} ({transaction['parentId']}) | {transaction['type']} | {transaction['transactionRef']} ({transaction['transactionId']}) | {'; '.join(quantities)} |")
lines += [
    '', 'Each record was independently fetched and verified for its external ID, parent ID, transaction type, exact selected quantities, item identities, and locations. Live selected-line remaining quantities are zero. The new SO parents are Pending Billing (fully fulfilled); the new PO parents are Pending Bill (fully received). Both new IR commands completed local receiving finalization.', '',
    'SOA09523 was posted successfully and subsequently marked `reconciled` by concurrent background processing. Its IF156234 identity and verified evidence remain intact, with one posting attempt. The semantic counts above count it as a new IF, not as an already-complete skip.', '',
    '## Orders held', '',
    '| Order | Persisted status | Required correction |',
    '|---|---|---|',
]
for row in verification['heldOrders']:
    if row['dispatch_order_ref'] == 'SOA08709':
        reason = 'Reconcile the completed order and its lines across different outbound yards.'
    elif row['dispatch_order_ref'] == 'SOA09128':
        reason = 'Resolve the user-defined NetSuite workflow lock so the exact REST source can be verified.'
    else:
        reason = 'Reconcile delivered/loaded quantity evidence with the Dispatch target; current proof does not conserve the target quantity.'
    lines.append(f"| {row['dispatch_order_ref']} | {row['status']} | {reason} |")
lines += [
    '', 'These seven candidates have zero posting attempts and no new IF. Their blockers remain persisted for follow-up. No quantity, yard, or NetSuite workflow restriction was bypassed.', '',
    '## Already-fulfilled split lines', '',
    '| Split | Parent | NetSuite line | Delivered / fulfilled | Live remaining |',
    '|---|---|---|---|---|',
]
for row in reconciliation['reconciled']:
    for check in row.get('checks', []):
        lines.append(f"| {row['orderRef']} | {row['parent']} | {check['orderLine']} (key {check['lineKey']}) | {check['fulfilled']:g} | {check['remaining']:g} |")
lines += [
    '', 'The selected split lines were matched by local parent, stable source line key, REST order-line number, item, and location before reconciliation. No new fulfillment was sent.', '',
    '## Approved gates', '',
    '| Gate | Enabled | Revision |',
    '|---|---|---|',
]
for gate in verification['gates']:
    lines.append(f"| {gate['flag_key']} | {str(gate['enabled']).lower()} | {gate['revision']} |")
lines += [
    '', f"The retry enabled {len(retry['gateChanges'])} gates that were still off. Receiving IR for 2967 was already enabled by the time the retry ran.", '',
    '## Audit files', '',
    '- [All 512 SO results](completed-order-results.csv)',
    '- [Independent live verification](live-verification.json)',
    '- [Original read-only backlog snapshot](live-audit-before.json)',
    '- [Authorized retry results](live-retry.json)',
    '- [Zero-remaining reconciliation and workflow hold](live-reconciliation.json)',
    '- [Implementation and release evidence](../../test/direct-ship-posting-evidence.md)', '',
]
(OUT / 'retry-report.md').write_text('\n'.join(lines))
print(json.dumps({'passed': True, 'report': str(OUT / 'retry-report.md'), 'csvRows': len(verification['fulfillments'])}))
