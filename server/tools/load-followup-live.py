"""Run scoped, audited reconciliation; default modes are read-only or rollback."""
from pathlib import Path
import base64
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/load-followup'
mode = sys.argv[1]
assert mode in ['repair-dry-run', 'repair', 'audit', 'refresh-audit', 'status', 'verify']
apply = mode in ['repair', 'refresh-audit']


def module_url(file, replacements=None):
    source = (ROOT / file).read_text().replace("'../src/", "'file:///app/src/")
    for old, new in (replacements or {}).items():
        source = source.replace(old, new)
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()


script = """
import crypto from 'node:crypto';
import {pool,query,withTransaction,closeDb} from '/app/src/db.js';
pool.options.options='-c jit=off -c statement_timeout=30000';
"""
if mode in ['audit', 'status', 'verify']:
    script += "pool.options.options+=' -c default_transaction_read_only=on';\n"
if mode == 'status':
    script += """
try{console.log(JSON.stringify({
 activePosting:(await query("SELECT count(*)::int n FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')")).rows[0].n,
 runningWebhooks:(await query("SELECT count(*)::int n FROM netsuite_order_webhook_inbox WHERE status='running'")).rows[0].n,
 queuedWebhooks:(await query("SELECT count(*)::int n FROM netsuite_order_webhook_inbox WHERE status='queued'")).rows[0].n,
 incidentStatus:(await query("SELECT status FROM operator_netsuite_posting_commands WHERE id='8574bd86-a8fb-48ee-aba5-042d85734d4f'")).rows[0]?.status
}));}finally{await closeDb();}
"""
elif mode == 'verify':
    script += """
import assert from 'node:assert/strict';
import {getDeliveryOrder} from '/app/src/delivery-repository.js';
import {getOperatorNetSuitePostingCommand} from '/app/src/operator-netsuite-posting-repository.js';
try{
 const command=await getOperatorNetSuitePostingCommand('8574bd86-a8fb-48ee-aba5-042d85734d4f');
 assert.equal(command.status,'completed');assert.equal(command.activeClaims.length,0);
 assert.equal(command.inputHash,'ac3371e4b3e23787405c07ea6d5077864de73f2e08d9f3fe6f2b08348d3d9195');
 assert.equal(command.steps[0].netSuiteTransactionId,996410);assert.equal(command.steps[0].netSuiteTransactionRef,'IF153890');
 const order=await getDeliveryOrder(995451,{includeNetSuiteClosed:true});assert.ok(order);
 assert.ok(!order.posting?.loadBlocked);
 if(order.confirmationSummary)assert.equal(order.confirmationSummary.total,0);
 const lines=(await query('SELECT line_id,item_id,quantity,loaded_qty,confirmed,packed_sales_qty,packed_pallet_qty,packed_layer_qty,packed_piece_qty,packed_section_qty FROM sales_order_lines WHERE sales_order_id=995451 ORDER BY line_id')).rows;
 assert.deepEqual(lines.map(row=>[Number(row.line_id),Number(row.loaded_qty)]),[[4967884,156.75],[4967885,24.6],[4967886,2],[4967891,2]]);
 assert.ok(lines.every(row=>['packed_sales_qty','packed_pallet_qty','packed_layer_qty','packed_piece_qty','packed_section_qty'].every(field=>Number(row[field])===0)));
 const loads=(await query('SELECT id,load_request_id,jsonb_array_length(line_snapshot) AS lines FROM operator_load_records WHERE order_id=995451')).rows;
 assert.equal(loads.length,1);assert.equal(loads[0].lines,4);
 console.log(JSON.stringify({verified:true,readOnly:true,orderRef:order.tranid,operatorStatus:order.operator_status,sourceStatus:order.status,
  commandStatus:command.status,transactionId:996410,transactionRef:'IF153890',remainingConfirmableLines:lines.filter(row=>Number(row.quantity)-Number(row.loaded_qty)>0.000001).length,
  loadStateFeatureDeployed:Boolean(order.confirmationSummary),
  activeClaims:command.activeClaims.length,loadRecords:loads,lines,immutableSubmissionPreserved:true},null,2));
}finally{await closeDb();}
"""
elif mode.startswith('repair'):
    url = module_url('tools/sob120541-repair.mjs')
    script += """
import {fetchItemFulfillmentFromNetSuite,fetchDeliveryOrderDetailsFromNetSuite} from '/app/src/netsuite.js';
async function snapshot(){return withTransaction(async()=>({
 order:(await query('SELECT * FROM sales_orders WHERE netsuite_id=995451')).rows,
 lines:(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=995451 ORDER BY id')).rows,
 commands:(await query("SELECT * FROM operator_netsuite_posting_commands WHERE id='8574bd86-a8fb-48ee-aba5-042d85734d4f'")).rows,
 steps:(await query("SELECT * FROM operator_netsuite_posting_steps WHERE command_id='8574bd86-a8fb-48ee-aba5-042d85734d4f' ORDER BY id")).rows,
 claims:(await query("SELECT * FROM operator_netsuite_posting_order_claims WHERE command_id='8574bd86-a8fb-48ee-aba5-042d85734d4f' ORDER BY local_order_key")).rows,
 loads:(await query('SELECT * FROM operator_load_records WHERE order_id=995451 ORDER BY id')).rows
}));}
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
try{
 const record=await fetchItemFulfillmentFromNetSuite(996410),sourceLines=await fetchDeliveryOrderDetailsFromNetSuite(995451);
 const before=await snapshot();
 const {reconcileSob120541}=await import(MODULE_URL);
 const result=await reconcileSob120541({record,sourceLines},{apply:APPLY});
 const after=await snapshot();
 if(!APPLY && hash(before)!==hash(after))throw new Error('Dry run changed production state');
 console.log(JSON.stringify({result,beforeHash:hash(before),afterHash:hash(after),before,after},null,2));
}finally{await closeDb();}
""".replace('MODULE_URL', json.dumps(url)).replace('APPLY', str(apply).lower())
else:
    helper = module_url('src/operator-load-state.js')
    url = module_url('tools/load-followup-audit.mjs', {'file:///app/src/operator-load-state.js': helper})
    approved = json.loads((ARTIFACT / 'header-refresh-plan.json').read_text())['approvedHeaders'] if mode == 'refresh-audit' else None
    script += """
const {auditDiscardedOrderUpdates}=await import(MODULE_URL);
try{const result=await auditDiscardedOrderUpdates({apply:APPLY,approvedHeaders:APPROVED_HEADERS,onResult:row=>console.error(JSON.stringify(row))});
 console.log(JSON.stringify(result,null,2));}finally{await closeDb();}
""".replace('MODULE_URL', json.dumps(url)).replace('APPLY', str(apply).lower()).replace('APPROVED_HEADERS', json.dumps(approved))

result = subprocess.run(['docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module'],
                        input=script, text=True, capture_output=True, timeout=300)
if result.returncode:
    (ARTIFACT / (mode + '-error.log')).write_text(result.stderr)
    raise SystemExit(result.stderr[-5000:])
report = json.loads(result.stdout)
output = ARTIFACT / (mode + '.json')
output.write_text(json.dumps(report, indent=2))
output.chmod(0o600)
print(json.dumps({key: value for key, value in report.items() if key not in ['before', 'after']}, indent=2))
