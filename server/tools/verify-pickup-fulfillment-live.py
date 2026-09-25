"""Read-only live evidence replay; selected quantities exist only in memory."""
import base64
import json
from pathlib import Path
import subprocess

SERVER = Path(__file__).resolve().parents[1]


def uri(text):
    return 'data:text/javascript;base64,' + base64.b64encode(text.encode()).decode()


domain = uri((SERVER / 'src/operator-pickup-existing-if-domain.js').read_text())
source = (SERVER / 'src/operator-pickup-existing-if-source.js').read_text()
source = source.replace("'./operator-pickup-existing-if-domain.js'", json.dumps(domain))
for name in ['netsuite.js', 'operator-netsuite-request-pool.js']:
    source = source.replace("'./" + name + "'", json.dumps('file:///app/src/' + name))
script = """
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '/app/src/db.js';
const {fetchPickupExistingFulfillment}=await import(SOURCE);
const requestLog=[];
let sourceLines=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async function(resource,init={}) {
  const url=new URL(typeof resource==='string'?resource:resource.url||resource);
  const method=init.method||'GET';
  assert.ok(method==='GET'||method==='POST'&&/\\/query\\/v1\\/suiteql$|\\/auth\\/oauth2\\/v1\\/token$/u.test(url.pathname), 'Unexpected write request');
  requestLog.push({method,path:url.pathname});
  const response=await originalFetch(resource,init);
  if(/\\/salesOrder\\/\\d+$/u.test(url.pathname)) {
    const data=await response.clone().json();
    sourceLines=(data.item?.items||[]).map(line=>({key:line.lineUniqueKey,quantity:line.quantity,units:line.units,unitsDisplay:line.unitsDisplay}));
  }
  return response;
};
try {
 const results=[];
 for(const id of [963486,963509,963561,963502]) {
  const order=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const header=(await query('SELECT * FROM sales_orders WHERE netsuite_id=$1',[id])).rows[0];
    const lines=(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1 AND netsuite_active=true ORDER BY id',[id])).rows;
    return {...header,order_type:'sales_order',lines};
  },{rollback:true});
  // SOA07444 was already locally refreshed earlier; recreate only its prior
  // pending quantity in this in-memory replay, never in the database.
  if(id===963502) {for(const line of order.lines) line.loaded_qty=0;}
  const selectedItems=order.lines.filter(line=>['InvtPart','NonInvtPart'].includes(line.item_type)&&Number(line.quantity)>Number(line.loaded_qty||0))
    .map(line=>({orderLine:line.line_id,quantity:Number(line.quantity)-Number(line.loaded_qty||0),location:Number(line.location_id||order.outbound_location_id)}));
  assert.ok(selectedItems.length);
  const begin=Date.now();
  let source;
  try {source=await fetchPickupExistingFulfillment({order,sourceNetSuiteId:id,sourceOrderRef:order.tranid,selectedItems});}
  catch(error) {
    results.push({order:order.tranid,error:error.message,sourceLines,localLines:order.lines.map(line=>({key:line.line_id,quantity:line.quantity,loaded:line.loaded_qty,unit:line.unit})),selectedItems});
    continue;
  }
  assert.equal(source.postingStrategy,'verified_pickup_if_v1');
  assert.ok(source.availableLines.every(line=>line.remainingQuantity===0));
  results.push({order:order.tranid,sourceId:id,lines:source.availableLines.length,
    existingIFs:[...new Set(source.availableLines.flatMap(line=>line.linkedTransactions.map(transaction=>transaction.ref)))],elapsedMs:Date.now()-begin});
 }
 console.log(JSON.stringify({results,networkReads:requestLog.length,localWrites:0,fulfillmentWrites:0}));
} finally {await closeDb();}
""".replace('SOURCE', json.dumps(uri(source)))
result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module'],
                        input=script, text=True, capture_output=True)
if result.returncode:
    # Data-URL stack traces contain the full source; retain privately in artifacts.
    path = SERVER / 'test-artifacts/pickup-existing-if/live-replay-error.log'
    path.write_text(result.stderr)
    raise RuntimeError('Live read failed; see ' + str(path))
print(result.stdout.strip())
