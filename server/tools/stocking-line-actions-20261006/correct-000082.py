"""Apply only the user's audited STREQ-000082 resolution correction."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
TASK = ROOT / 'tools/stocking-line-actions-20261006'
AUDIT = Path('/home/ubuntu/operatorapp-investigations/stocking-line-actions-20261006/correction')
APP = 'mbbs-operator-app-app-1'
INPUT = {'requestId': 122, 'requestRef': 'STREQ-000082', 'lineName': 'BWS-HUNT70S-RDM-SM',
         'expectedRevision': 2, 'purchaseOrderRef': 'POB03992', 'eta': '2026-10-08'}

def node(script):
    return json.loads(subprocess.check_output(['docker', 'exec', '-i', '-w', '/app', APP,
        'node', '--input-type=module'], input=script.encode()))

def snapshot():
    return node("""import {query,withTransaction,closeDb} from './src/db.js';
    try{const value=await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');
      return (await query(`SELECT to_jsonb(r)||jsonb_build_object('lines',(SELECT jsonb_agg(l ORDER BY l.id) FROM sales_stock_request_lines l WHERE l.request_id=r.id),
        'events',(SELECT jsonb_agg(e ORDER BY e.id) FROM sales_stock_request_events e WHERE e.request_id=r.id)) AS snapshot FROM sales_stock_requests r WHERE id=122 AND request_ref='STREQ-000082'`)).rows[0].snapshot;});
      console.log(JSON.stringify(value));}finally{await closeDb();}""")

mode = sys.argv[1]
assert mode in ['dry-run', 'apply', 'verify']
AUDIT.mkdir(parents=True, exist_ok=True)
before = snapshot()
if mode != 'verify':
    if not (AUDIT / 'before.json').exists():
        (AUDIT / 'before.json').write_text(json.dumps(before, indent=2))
    summary = json.loads((ROOT / 'test-artifacts/stocking-line-actions-20261006/summary.json').read_text())
    assert summary['focused']['fail'] == 0 and not summary['newFailures']
    source = (TASK / 'repair.mjs').read_bytes()
    assert hashlib.sha256(source).hexdigest() == summary['toolManifest']['repair.mjs']
    if mode == 'apply':
        dry = json.loads((AUDIT / 'dry-run.json').read_text())
        assert dry['beforeRevision'] == before['revision'] and dry['changed']
    script = source.decode().replace('../../src/', './src/')
    script += "\nimport {closeDb} from './src/db.js';\ntry{console.log(JSON.stringify(await repairStockingResolutionScope(" + json.dumps(INPUT) + ", {rollback:" + str(mode == 'dry-run').lower() + "})));}finally{await closeDb();}\n"
    result = node(script)
    after = snapshot()
    if mode == 'dry-run':
        assert after == before
    result['beforeRevision'] = before['revision']
    (AUDIT / (mode + '.json')).write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
else:
    after = before
if mode != 'dry-run':
    assert after['status'] == 'active' and after['revision'] == 3
    assert 'resolution' not in after['regular_details']
    target = next(line for line in after['lines'] if line['item_name'] == INPUT['lineName'])
    assert target['id'] == 165 and target['status'] == 'closed'
    resolution = after['regular_details']['stockingLines']['165']['resolution']
    assert resolution['purchaseOrderRef'] == INPUT['purchaseOrderRef'] and resolution['eta'] == INPUT['eta']
    pending = [line for line in after['lines'] if line['id'] != 165]
    assert sorted(line['id'] for line in pending) == [166, 167, 168]
    assert all(line['status'] == 'submitted' and line['regular_decision'] is None and not line['decision_reason'] for line in pending)
    original = json.loads((AUDIT / 'before.json').read_text())
    assert [[line['id'], line['sales_qty'], line['sales_uom'], line['approval_evidence']] for line in after['lines']] == [[line['id'], line['sales_qty'], line['sales_uom'], line['approval_evidence']] for line in original['lines']]
    assert all(event in after['events'] for event in original['events'])
    (AUDIT / 'after.json').write_text(json.dumps(after, indent=2))
    print(json.dumps({'verified': True, 'request': INPUT['requestRef'], 'resolvedMaterial': target['item_name'],
        'purchaseOrder': resolution['purchaseOrderRef'], 'eta': resolution['eta'], 'pendingMaterials': [line['item_name'] for line in pending]}), flush=True)
