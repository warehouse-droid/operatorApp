#!/usr/bin/env python3
"""Read-only post-release verification of the two reported Gravel deliveries."""
import hashlib
import json
import runpy
import subprocess
from pathlib import Path

base = runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
out = base['SERVER'] / 'deployments/bin-cargo-plan-20261023'
baseline = base['SERVER'] / 'deployments/bin-cargo-routing-20261023'
script = r'''
import {query,withTransaction,closeDb} from './src/db.js';
import {getBinCargoOptions} from './src/mbt/bin-cargo-service.js';
import {getBinOrderWorkflowOptions} from './src/mbt/bin-order-workflow-service.js';
try {
  const report=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const orders=(await query(`SELECT o.order_id,o.display_reference,v.service_snapshot,l.pricing_snapshot
      FROM mbt_bin_orders o JOIN mbt_service_visits v ON v.service_visit_id=o.order_id
      JOIN mbt_contract_service_lines l ON l.service_line_id=o.service_line_id
      WHERE o.display_reference=ANY($1::text[]) ORDER BY o.display_reference`,[['BIN00003D','BIN00004D']])).rows;
    const details=[];
    for(const order of orders) {
      const data=await getBinCargoOptions(order.order_id),workflow=await getBinOrderWorkflowOptions(order.order_id);
      details.push({reference:data.reference,workflowEditable:!workflow.configurationIssue,editable:data.editable,mode:data.cargo.mode,
        orderedMaterials:data.orderedMaterials.map(m=>({name:m.displayName,quantityMilliYards:m.quantityMilliYards,weightLbs:m.derivedWeightLbs})),
        pickupConfigured:data.cargo.materials.map(m=>Boolean(m.pickup)),
        yardCodes:data.yards.map(y=>y.yardCode),steps:data.steps.map(s=>s.actionCode)});
    }
    return {orders,details};
  });
  console.log(JSON.stringify(report));
} finally {await closeDb();}
'''
current = json.loads(base['docker']('exec', '-i', base['APP'], 'node', '--input-type=module', data=script.encode()))
before = json.loads((baseline / 'live-order-read.json').read_text())['orders']
digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
snapshots = []
for order in current['orders']:
    old = next(row for row in before if row['order_id'] == order['order_id'])
    snapshots.append({'reference': order['display_reference'], **{
        field + 'Unchanged': digest(order[field]) == digest(old[field])
        for field in ['service_snapshot', 'pricing_snapshot']}})
assert len(current['details']) == 2, 'Both reported deliveries should be readable'
for row in current['details']:
    assert {'3445', '2967', '150'}.issubset(set(row['yardCodes'])), row['reference']
    assert any(item['name'] == 'Gravel' for item in row['orderedMaterials']), row['reference']
http = []
for path, expected in [('/bin-cargo-ui.js', 200),
                       ('/api/mbt/planning/workflows/' + current['orders'][0]['order_id'] + '/cargo', 401)]:
    status = int(subprocess.check_output(['curl', '-sS', '--max-time', '15', '-o', '/dev/null',
                                         '-w', '%{http_code}', 'http://127.0.0.1:3000' + path], text=True))
    assert status == expected, (path, status)
    http.append({'path': path, 'status': status})
workflow_ui = base['docker']('exec', base['APP'], 'cat', '/app/public/bin-order-workflow-ui.js')
planning_ui = base['docker']('exec', base['APP'], 'cat', '/app/public/mbt-planning.js')
assert '<section data-bin-cargo></section>' in workflow_ui
assert 'cargo:cargoEditor.value()' in workflow_ui
assert 'data-bin-cargo' not in planning_ui
report = {'cargoEditorInPlan': True, 'detailsHasNoCargoEditor': True, 'readOnly': True, 'details': current['details'], 'orderSnapshots': snapshots, 'http': http}
base['save'](out / 'live-cargo-verification.json', report)
print(json.dumps(report))
