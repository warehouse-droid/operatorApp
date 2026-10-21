"""Produce reviewable CSVs and an audit summary from read-only source evidence."""
import collections
import csv
import json
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-artifacts' / 'aggregate-uom-audit-20261008'
data = json.loads((OUT / 'collection.json').read_text())
units = json.loads((OUT / 'item-units.json').read_text())
source = collections.defaultdict(list)
aliases = collections.defaultdict(list)
for row in data['source']:
    source[(row['order_id'], row['line_id'], row['item_id'])].append(row)
    aliases[(row['order_id'], row['order_line'], row['item_id'])].append(row)


def number(value):
    return Decimal(str(value or 0))


def equal(left, right):
    return abs(number(left) - number(right)) <= Decimal('0.000001')


def write_csv(name, rows):
    if not rows:
        return
    with (OUT / name).open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


counts = {}
historical = []
unresolved = []
legacy = []
open_sales = []
purchase_drift = []
backorder_drift = []
state_drift = []
for kind, key in [('SO', 'sales_order_id'), ('PO', 'purchase_order_id'), ('TO', 'transfer_order_id')]:
    summary = collections.Counter(localLines=len(data['local'][kind]))
    for local in data['local'][kind]:
        identity = (local[key], local['line_id'], local['item_id'])
        matches = source[identity]
        legacy_match = False
        if not matches and int(local['line_id']) < 1000:
            matches = aliases[identity]
            legacy_match = len(matches) == 1
        if len(matches) != 1:
            summary['unmatchedInactiveLines'] += 1
            unresolved.append({'kind': kind, 'order': local['tranid'], 'row_id': local['id'],
                               'order_id': local[key], 'line_id': local['line_id'],
                               'item_id': local['item_id'], 'item': local['item_name'],
                               'local_quantity': local['quantity'], 'unit': local['unit'],
                               'line_active': local['netsuite_active'], 'order_active': local['order_active'],
                               'reason': 'Source line no longer appears on the NetSuite order'})
            continue
        remote = matches[0]
        factor = number(remote.get('conversion_rate') or 1)
        assert factor > 0
        native = abs(number(remote.get('quantity'))) / factor
        progress = abs(number(remote.get('progress_quantity'))) / factor
        worked = bool(local.get('confirmed') or local.get('confirmed_at') or any(number(local.get(field)) != 0
                      for field in ['loaded_qty', 'packed_sales_qty', 'packed_pallet_qty', 'packed_layer_qty',
                                    'packed_piece_qty', 'packed_section_qty', 'received_sales_qty',
                                    'received_pallet_qty', 'received_layer_qty', 'received_piece_qty', 'received_section_qty']))
        record = {'order': local['tranid'], 'order_id': local[key], 'date': local['trandate'][:10],
                  'row_id': local['id'], 'line_id': local['line_id'], 'item_id': local['item_id'],
                  'item': local['item_name'], 'local_quantity': local['quantity'],
                  'netsuite_native_quantity': str(native.normalize()), 'unit': remote.get('unit', ''),
                  'conversion_rate': str(factor), 'loaded_quantity': local.get('loaded_qty') or '0',
                  'packed_sales_quantity': local.get('packed_sales_qty') or '0',
                  'netsuite_fulfilled_quantity': str(progress.normalize()),
                  'local_status': local['order_status_text'], 'netsuite_status': remote['status_text'],
                  'has_local_execution_state': worked, 'last_line_sync': local['synced_at']}
        if legacy_match:
            summary['legacyOrderLineMatches'] += 1
            legacy.append({**record, 'netsuite_unique_line_key': remote['line_id']})
        if equal(local['quantity'], native):
            summary['matchingQuantityLines'] += 1
        elif equal(local['quantity'], native * factor):
            summary['baseQuantityMislabeledAsNative'] += 1
            assert kind == 'SO' and remote['status'] == 'G', 'Review an unexpected active mismatch separately'
            historical.append(record)
            summary['mismatchWithExecution' if worked else 'mismatchWithoutExecution'] += 1
        else:
            raise ValueError(f"Unclassified quantity difference: {local['tranid']}/{local['line_id']}")
        if kind == 'SO' and local['netsuite_active'] and local['order_active'] and local['order_status'] in ['A', 'B', 'D', 'E']:
            open_sales.append(record)
        if kind == 'PO':
            if not equal(local.get('netsuite_received_qty'), progress):
                purchase_drift.append({'order': local['tranid'], 'order_id': local[key], 'line_id': local['line_id'],
                                       'item': local['item_name'], 'unit': local['unit'],
                                       'local_received_quantity': local['netsuite_received_qty'],
                                       'netsuite_received_quantity': str(progress.normalize()),
                                       'local_baseline_quantity': local['netsuite_received_baseline_qty'],
                                       'local_status': local['order_status_text'], 'netsuite_status': remote['status_text'],
                                       'last_line_sync': local['synced_at']})
            if local['order_status'] != remote['status']:
                state_drift.append({'order': local['tranid'], 'local_status': local['order_status_text'], 'netsuite_status': remote['status_text']})
        if kind == 'SO' and not equal(local.get('netsuite_backordered_qty'), abs(number(remote.get('backordered_quantity'))) / factor):
            backorder_drift.append({'order': local['tranid'], 'line_id': local['line_id'], 'item': local['item_name'],
                                   'local_backordered_quantity': local['netsuite_backordered_qty'],
                                   'netsuite_backordered_quantity': str(abs(number(remote.get('backordered_quantity'))) / factor),
                                   'unit': local['unit'], 'netsuite_status': remote['status_text']})
    counts[kind] = dict(summary)

weights = []
for item in units['items']:
    stock_weight = number(item['item_weight'])
    assert item['weight_unit'] == 'kg'
    per_purchase_kg = stock_weight * number(item['purchase_conversion_rate']) / number(item['stock_conversion_rate'])
    weights.append({'item_id': item['id'], 'item': item['itemid'], 'source_weight': item['item_weight'],
                    'source_weight_unit': item['weight_unit'], 'stock_conversion_rate': item['stock_conversion_rate'],
                    'sales_conversion_rate': item['sales_conversion_rate'], 'purchase_conversion_rate': item['purchase_conversion_rate'],
                    'expected_lb_per_stock_unit': str((stock_weight / Decimal('0.45359237')).quantize(Decimal('.000001'))),
                    'expected_kg_per_purchase_unit': str(per_purchase_kg.normalize()),
                    'expected_lb_per_purchase_unit': str((per_purchase_kg / Decimal('0.45359237')).quantize(Decimal('.000001')))})

write_csv('historical-quantity-mismatches.csv', historical)
write_csv('open-sales-orders.csv', open_sales)
write_csv('purchase-receipt-drift.csv', purchase_drift)
write_csv('historical-backorder-drift.csv', backorder_drift)
write_csv('inactive-source-lines.csv', unresolved)
write_csv('legacy-line-matches.csv', legacy)
write_csv('item-conversions-and-weights.csv', weights)
unique_states = list({row['order']: row for row in state_drift}.values())
write_csv('purchase-status-drift.csv', unique_states)

report = {
    'scope': 'Every locally stored line for all 11 NetSuite aggregate items, with no date cutoff',
    'collectedAt': data['collectedAt'],
    'sourceLinesRead': len(data['source']),
    'sourceOrdersRead': len({row['order_id'] for row in data['source']}),
    'localLineCounts': counts,
    'localSalesOrders': len({row['sales_order_id'] for row in data['local']['SO']}),
    'localPurchaseOrders': len({row['purchase_order_id'] for row in data['local']['PO']}),
    'openSalesOrders': len({row['order_id'] for row in open_sales}),
    'historicalMismatchLines': len(historical),
    'historicalMismatchOrders': len({row['order_id'] for row in historical}),
    'historicalMismatchWithExecution': sum(row['has_local_execution_state'] for row in historical),
    'purchaseReceivedQuantityDriftLines': len(purchase_drift),
    'purchaseReceivedQuantityDriftOrders': len({row['order_id'] for row in purchase_drift}),
    'purchaseStatusDriftOrders': unique_states,
    'historicalBackorderDriftLines': len(backorder_drift),
    'diagnosis': [
        'The October 3 native-unit fix is present in the app and worker. All seven current open aggregate SO quantities match.',
        'The original repair covered October 1 onward and omitted aggregate item 9909 (Screening). Older source and execution caches were not comprehensively reconciled.',
        'All 58 PO order quantities match their NetSuite Ton units. Receipt progress and some header statuses are stale independently of the conversion issue.',
        'Dispatch interprets item_weight as pounds, while all 11 aggregate item records configure kilograms. PO lines additionally reuse weight per stock unit despite buying in Ton.',
        'The NetSuite webhook sends base-unit item weight (about 1000 for these items), while SuiteQL reads weight per stock Yard (1300 or 1350); neither path carries sufficient weight basis into the app.',
        'Regular Stock and Returns still read SuiteQL base quantities as Yard. Returns also reads base-unit prices. Both discrepancies were verified live on SOB121756.',
        'The Smart SCM sales-history reader returns base quantities. The API sales-history sync is currently suspended and aggregate planning is disabled for all 11 items; historical CSV/workbook facts need unit review before planning is enabled.'
    ],
    'limits': [
        'This is an audit, not a blanket historical data rewrite or runtime deployment. No new production record changes were made in this broader check.',
        'Ten old rows use REST line numbers rather than unique keys; exact order/item/line-number matches agree on quantity. Eleven remaining source lines are inactive/deleted and were not reconstructed.',
        'Inventory on-hand stock-unit conversion was not independently verified: the REST item returned no per-location quantities. No all-clear is claimed for that basis.',
        'Returns currently excludes these aggregate items through the default non-returnable policy; the conversion defects are still present in the underlying reader.',
        'Historical packing/loading requires source-fulfillment reconciliation. In two rows the loaded quantity is neither the complete old base quantity nor the native source quantity.',
        'SOA04928 has a NetSuite line amount of 115.92 versus quantity times rate of 126 (an 8% difference). Its REST record is workflow-locked, so discount evidence could not be inspected. This is recorded as an unresolved source pricing exception, not a proven application conversion bug.'
    ],
    'repairSequence': [
        'Normalize weight unit and weight-per-transaction basis at both SuiteQL and webhook ingestion, including inventory-to-PO weight refresh.',
        'Apply unit normalization to Regular Stock, Returns and any enabled demand/inventory reader; preserve native REST quantities and per-unit prices.',
        'Reconcile completed source quantities and historical execution projections against exact NetSuite fulfillment evidence; retain original operational logs.',
        'Refresh aggregate PO receipt progress and status through existing reconciliation, accounting for local receipt baselines and allocations.',
        'Rebuild affected current display projections and verify final quantity, price and load-weight calculations.'
    ]
}
(OUT / 'audit-summary.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: report[key] for key in ['localLineCounts', 'openSalesOrders', 'historicalMismatchLines',
                                            'historicalMismatchOrders', 'purchaseReceivedQuantityDriftLines',
                                            'purchaseReceivedQuantityDriftOrders']}, indent=2))
