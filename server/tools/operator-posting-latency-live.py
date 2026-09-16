"""Replay candidate receiving reads against the live SN in a READ ONLY transaction."""
import base64
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = (root / 'src/receiving-repository.js').read_text().replace('from "./', 'from "file:///app/src/')
module = 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()
script = '''
import assert from 'node:assert/strict';
import {query,withTransaction,pool} from './src/db.js';
const candidate = await import(MODULE);
try {
 await withTransaction(async()=>{
  await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const order=(await query("SELECT netsuite_id,tranid,receipt_status,status_text,last_item_receipt_id FROM purchase_orders WHERE tranid=$1",['SN1400333'])).rows[0];
  assert.ok(order); assert.equal(order.receipt_status,'received');
  const list=await candidate.listReceivingOrders({orderType:'purchase_order',search:order.tranid});
  assert.ok(!list.some(row=>String(row.netsuite_id)===String(order.netsuite_id)));
  await assert.rejects(candidate.getReceivableReceivingOrder(order.netsuite_id,{includeNetSuiteClosed:true}),{code:'RECEIVING_ALREADY_COMPLETED',status:409});
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),mode:'read-only; candidate code in memory',order:order.tranid,receiptStatus:order.receipt_status,itemReceiptId:order.last_item_receipt_id,hidden:true,repeatReceivingStatus:409}));
 });
} finally {await pool.end();}
'''.replace('MODULE', json.dumps(module))
result = subprocess.run(['docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module'], input=script, text=True, capture_output=True, check=True)
report = json.loads(result.stdout)
destination = root / 'test-artifacts/operator-posting-latency/live.json'
destination.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
