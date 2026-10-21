"""Read-only verification of POB03976 display and recipient mapping."""
import json
from pathlib import Path
import subprocess
import sys

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/special-po-reference-20261001'
MODE=sys.argv[1] if len(sys.argv)>1 else 'verify'
assert MODE in ['before','verify']
SCRIPT=r"""
import assert from 'node:assert/strict';
import { query,withTransaction,closeDb } from './src/db.js';
import {getSpecialStockCase} from './src/special-stock-request-repository.js';
const mode=process.argv[2];
try{
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const row=(await query("SELECT p.netsuite_id,p.tranid,p.dispatch_ref,p.netsuite_note,r.id,r.request_ref,r.requested_by,r.destination_location_id FROM purchase_orders p JOIN sales_special_stock_cases c ON c.purchase_order_netsuite_id=p.netsuite_id JOIN sales_stock_requests r ON r.id=c.request_id WHERE p.tranid='POB03976'")).rows[0];
  assert.ok(row);assert.equal(row.dispatch_ref,'SN1401857');assert.equal(row.netsuite_note,'for SOB121819');
  const detail=await getSpecialStockCase(row.id,{audience:'sales'});
  assert.equal(detail.purchaseOrderReference,row.dispatch_ref);
  const data={readOnly:true,requestWrites:0,receiptWrites:0,netsuiteWrites:0,requestRef:row.request_ref,
    poRef:row.tranid,scmReference:row.dispatch_ref,poNote:row.netsuite_note,fulfillmentMethod:detail.fulfillmentMethod,stage:detail.stage};
  if(mode==='verify'){
   const {specialPurchaseOrderDisplayRef,poReferenceAlertAudience}=await import('./public/special-stock-po-reference.js');
   const {listSpecialPoReferenceAlerts}=await import('./src/special-po-reference-alerts.js');
   data.displayRef=specialPurchaseOrderDisplayRef(detail);assert.equal(data.displayRef,'POB03976 / SN1401857');
   data.audience=poReferenceAlertAudience(detail.fulfillmentMethod);
   const dispatcher=(await query("SELECT id FROM operators WHERE active AND (role IN ('dispatcher','admin') OR roles && ARRAY['dispatcher','admin']) LIMIT 1")).rows[0];assert.ok(dispatcher);
   const context={audience:data.audience,operatorId:data.audience==='sales'?row.requested_by:dispatcher.id,authorizedStoreLocationIds:[Number(row.destination_location_id)]};
   const pending=await listSpecialPoReferenceAlerts(context);
   const alert=pending.alerts.find(value=>value.requestId===Number(row.id));assert.ok(alert,'Example request must have its pending reference notice');
   assert.equal(alert.displayRef,data.displayRef);assert.equal(alert.audience,data.audience);
   data.exampleReferenceAlertPending=true;
  }
  return data;
 });
 if(mode==='verify'){
  for(const audience of ['sales','dispatch']){
   const response=await fetch('http://127.0.0.1:3000/api/'+audience+'/special-stock-requests/po-reference-alerts');assert.equal(response.status,401);
  }
  result.requiresAuthentication=true;
 }
 console.log(JSON.stringify(result));
}finally{await closeDb();}
"""
response=subprocess.run(['sudo','-n','docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module','-',MODE],input=SCRIPT.encode(),capture_output=True)
if response.returncode:
 print(response.stderr.decode(),end='');raise SystemExit(response.returncode)
report=json.loads(response.stdout)
if MODE=='verify':
 before=json.loads((OUT/'live-before.json').read_text())
 assert all(report[key]==before[key] for key in ['poRef','scmReference','poNote'])
 report['originalPoReferenceAndNoteUnchanged']=True
(OUT/('live-before.json' if MODE=='before' else 'live-requests.json')).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
