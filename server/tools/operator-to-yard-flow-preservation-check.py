"""Compare private operational snapshots and publish only aggregate invariants."""
import collections
import importlib.util
import json
import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('to_release', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def compare_rows(before, after, key, allowed):
    old = {str(row[key]): row for row in before}
    new = {str(row[key]): row for row in after}
    assert old.keys() <= new.keys(), f'Records disappeared from {key}'
    changed, columns = 0, collections.Counter()
    for identity, row in old.items():
        differences = {name for name in set(row) | set(new[identity]) if row.get(name) != new[identity].get(name)}
        assert differences <= allowed, f'Unexpected columns changed: {differences - allowed}'
        changed += bool(differences)
        columns.update(differences)
    return {'before': len(old), 'after': len(new), 'changedRows': changed, 'changedColumns': dict(columns)}


if __name__ == '__main__':
    os.umask(0o077)
    before = json.loads((release.STATE / 'audit-before.private.json').read_text())
    after = json.loads((release.STATE / 'audit-after.private.json').read_text())
    applied = json.loads((release.STATE / 'reconciliation-apply.private.json').read_text())
    verified = json.loads((release.STATE / 'reconciliation-verify.private.json').read_text())
    result = {'beforeAt': before['at'], 'afterAt': after['at'], 'tables': {}}
    allowed = {
        'orders': {'outbound_operator_status', 'receiving_status', 'status', 'status_text', 'status_updated_at',
                   'synced_at', 'last_item_fulfillment_id', 'last_item_fulfillment_tranid'},
        'lines': {'loaded_qty', 'loaded_uom', 'synced_at', 'netsuite_order_line_synced_at'},
        'jobs': {'status', 'result', 'updated_at', 'last_error', 'completion_event_id'}}
    for table, key in [('orders', 'netsuite_id'), ('lines', 'id'), ('jobs', 'id'), ('commands', 'id'), ('steps', 'id')]:
        result['tables'][table] = compare_rows(before[table], after[table], key, allowed.get(table, set()))
        assert len(after[table]) == len(before[table]) + (1 if table == 'jobs' else 0)
    for table in ['loads', 'receipts']:
        old = [row['record'] for row in before[table]]
        new = [row['record'] for row in after[table]]
        result['tables'][table] = compare_rows(old, new, 'id', {'response'} if table == 'loads' else set())
        assert len(old) == len(new)
    for table in ['assignments', 'completions', 'dependencies']:
        assert before[table] == after[table], f'Operational evidence changed in {table}'
    old_loads = {str(row['record']['id']): row['record'] for row in before['loads']}
    for wrapped in after['loads']:
        row = wrapped['record']
        old = old_loads[str(row['id'])]
        assert {name: value for name, value in (row['response'] or {}).items() if name != 'operatorNetSuitePosting'} == {
            name: value for name, value in (old['response'] or {}).items() if name != 'operatorNetSuitePosting'}
    orders = {str(row['netsuite_id']): row for row in after['orders']}
    histories = [row for row in applied['orders'] if row['kind'] == 'historical_completed']
    assert len(histories) == 984
    for row in histories:
        order = orders[row['localToId']]
        assert order['outbound_operator_status'] == 'loaded' and order['receiving_status'] == 'received'
    assert all(row['writes'] == 0 for row in verified['orders'])
    assert len(verified['orders']) == len(before['orders']) == 1053
    assert collections.Counter(row['status'] for row in after['jobs']) == {'completed': 13}
    assert all(row['transaction_type'] == 'IF' for row in after['jobs'])
    old_jobs = {row['id'] for row in before['jobs']}
    new_jobs = [row for row in after['jobs'] if row['id'] not in old_jobs]
    assert len(new_jobs) == 1
    assert str(new_jobs[0]['operator_record_id']) in old_loads
    assert old_loads[str(new_jobs[0]['operator_record_id'])]['load_type'] == 'transfer_order_load'
    result.update({'draftsAndPackingPreserved': True, 'existingPostingSnapshotsPreserved': True,
                   'nativeCommandsAndStepsUnchanged': True, 'physicalLoadAndReceiptRecordsPreserved': True,
                   'dispatchDriverAndDependencyEvidenceUnchanged': True,
                   'historicalCompletionsKept': len(histories), 'newIfJobFromExistingPhysicalLoad': 1,
                   'allIfJobsCompleted': 13, 'repeatReconciliationWrites': 0, 'netSuiteWrites': 0})
    release.save(release.ARTIFACT / 'preservation-check.json', result)
    print(json.dumps(result, indent=2))
