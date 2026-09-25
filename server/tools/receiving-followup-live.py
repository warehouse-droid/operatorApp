"""Build the real pallet-only receipt draft in a read-only production replay."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/receiving-followup'
deployed = '--deployed' in sys.argv


def module_url(file, replacements=None):
    source = (ROOT / file).read_text()
    for name, url in (replacements or {}).items():
        source = source.replace('from "./' + name + '"', 'from "' + url + '"')
    source = source.replace('from "./', 'from "file:///app/src/')
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()


helper = module_url('src/receiving-receipt-progress.js')
receiving = '/app/src/receiving-repository.js' if deployed else module_url('src/receiving-repository.js', {'receiving-receipt-progress.js': helper})
targets = '/app/src/operator-netsuite-posting-targets.js' if deployed else module_url('src/operator-netsuite-posting-targets.js',
    {'receiving-receipt-progress.js': helper, 'receiving-repository.js': receiving})
script = '''
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {pool,query,withTransaction,closeDb} from '/app/src/db.js';
import {buildOperatorNetSuitePostingDraft} from '/app/src/operator-netsuite-posting-domain.js';
import {fetchOperatorNetSuiteSourceItemLinesFromNetSuite,fetchItemReceiptFromNetSuite} from '/app/src/netsuite.js';
const receiving=await import(RECEIVING_URL);
const targets=await import(TARGETS_URL);
pool.options.options='-c jit=off -c default_transaction_read_only=on -c statement_timeout=30000';
try {
  const live=await fetchOperatorNetSuiteSourceItemLinesFromNetSuite('PO',939701);
  const ir=await fetchItemReceiptFromNetSuite(994070);
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const order=await receiving.getReceivingOrder('-81664606940713');
    assert.deepEqual(order.lines.map(line=>[line.sku,Number(line.quantity)]),[['PALLET',28]]);
    const source=targets.createOperatorNetSuitePostingRealSourceResolver({query,useStoredOrderLines:true});
    const resolve=targets.createOperatorNetSuitePostingTargetResolver({getDeliveryOrder:async()=>null,
      getReceivableReceivingOrder:receiving.getReceivableReceivingOrder,resolveRealSource:source});
    const resolution=await resolve({functionKey:'receiving',orderId:order.netsuite_id,orderType:'purchase_order',clientLocationId:1});
    const draft=buildOperatorNetSuitePostingDraft({...resolution,requestId:crypto.randomUUID(),actorOperatorId:'read-only-replay',photoRefs:[],
      policy:{gateKey:'operator_netsuite_receiving_ir_3445',revision:4,effective:true,functionKey:'receiving',transactionType:'IR',locationId:1,yardCode:'3445'}});
    assert.equal(draft.steps.length,1);
    const step=draft.steps[0];
    assert.deepEqual(step.payload.item.items.filter(line=>line.itemReceive),[{orderLine:34,location:1,itemReceive:true,quantity:28}]);
    assert.equal(step.payload.memo,'SN1400625');
    assert.equal(step.payload.custbody9,'SN1400625');
    assert.ok(!step.payload.item.items.some(line=>line.orderLine===25));
    for(const item of step.payload.item.items){
      const line=live.find(row=>Number(row.line)===Number(item.orderLine));
      assert.ok(line && !line.isClosed && Number(line.quantity)>Number(line.quantityReceived||0));
      if(item.itemReceive) assert.ok(item.quantity<=Number(line.quantity)-Number(line.quantityReceived||0));
    }
    const receiptLines=ir.item.items.filter(line=>line.itemReceive).map(line=>({orderLine:line.orderLine,itemId:line.item.id,quantity:line.quantity}));
    assert.equal(receiptLines.length,3);assert.ok(receiptLines.every(line=>Number(line.itemId)!==1784));
    const state={lines:(await query('SELECT * FROM purchase_order_lines WHERE purchase_order_id=-81664606940713 ORDER BY id')).rows,
      receipts:(await query('SELECT * FROM receiving_receipt_records WHERE order_id=-81664606940713 ORDER BY id')).rows};
    const activeClaims=(await query(`SELECT claim.local_order_key,command.status FROM operator_netsuite_posting_order_claims claim
      JOIN operator_netsuite_posting_commands command ON command.id=claim.command_id
      WHERE claim.local_order_key IN ('receiving:purchase_order:-81664606940713','source:IR:PO:939701')`)).rows;
    return {observedAt:new Date().toISOString(),readOnly:true,receiptSubmitted:false,displayLines:order.lines.map(line=>({sku:line.sku,quantity:line.quantity})),
      existingReceipt:{id:994070,ref:ir.tranId,lines:receiptLines},draft:step.payload,activeClaims,
      stateHash:crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex')};
  },{rollback:true});
  console.log(JSON.stringify(result,null,2));
}finally{await closeDb();}
'''.replace('RECEIVING_URL', json.dumps(receiving)).replace('TARGETS_URL', json.dumps(targets))
result = subprocess.run(['docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module'],
    input=script, text=True, capture_output=True, timeout=120)
if result.returncode:
    (ARTIFACT / 'live-error.log').write_text(result.stderr)
    raise SystemExit(result.stderr[-5000:])
report = json.loads(result.stdout)
report['sourceHashes'] = {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest() for file in
    ['src/receiving-repository.js', 'src/operator-netsuite-posting-targets.js', 'src/receiving-receipt-progress.js']}
(ARTIFACT / ('live-after.json' if deployed else 'live-candidate.json')).write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
