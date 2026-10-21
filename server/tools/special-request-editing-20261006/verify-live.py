"""Read current application behavior and verify prior recovery, health and disposal."""
import json
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-artifacts/special-request-editing-20261006'
APP='mbbs-operator-app-app-1'
PROJECT='mbbs-special-request-editing-20261006'
PRODUCTION=[APP,'mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1']
def docker(*args,**kwargs):return subprocess.check_output(['docker',*args],**kwargs)

subprocess.run(['python3',str(ROOT/'tools/special-request-editing-20261006/deploy.py'),'verify'],check=True)
script="""import assert from 'node:assert/strict';import {query,withTransaction,closeDb} from './src/db.js';
import {getSpecialStockCase} from './src/special-stock-request-repository.js';
import {specialFulfillmentEditor} from './public/special-stock-fulfillment.js';
import {specialDeliveryFeeDisplay} from './public/special-stock-delivery-fee.js';
try{const state=await withTransaction(async()=>{
 await query('SET TRANSACTION READ ONLY');
 const d=await getSpecialStockCase(125,{audience:'sales',authorizedStoreLocationIds:[1],dispatchPlans:[]});
 assert.equal(d.requestRef,'SPREQ-000041');assert.equal(d.salesOrderId,1042205);assert.equal(d.purchaseOrderId,1042761);
 assert.equal(d.purchaseOrderRef,'POB03999');assert.equal(d.purchaseOrderOperationStatus,'linked');assert.equal(d.attention,false);
 assert.ok(specialFulfillmentEditor(d).includes('data-special-note-form'));
 const prior=await getSpecialStockCase(106,{audience:'sales',authorizedStoreLocationIds:[1],dispatchPlans:[]});
 assert.equal(prior.salesOrderId,1041956);assert.equal(prior.salesOrderRef,'SOB122131');
 const zero=(await query("SELECT r.id,r.request_ref FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE c.delivery_fee_rate=0 AND c.close_status='active' ORDER BY r.id DESC LIMIT 3")).rows;
 for(const row of zero){const detail=await getSpecialStockCase(row.id,{audience:'scm',dispatchPlans:[]});assert.equal(specialDeliveryFeeDisplay(detail),'');}
 return {confirmedRequestRef:d.requestRef,noteEditable:true,purchaseOrderRef:d.purchaseOrderRef,operationStatus:d.purchaseOrderOperationStatus,
  attention:d.attention,priorSoLinkPreserved:true,zeroFeeRequestsChecked:zero.map(row=>row.request_ref),applicationWrites:0,netSuiteWrites:0};
});console.log(JSON.stringify(state));}finally{await closeDb();}"""
state=json.loads(docker('exec','-i','-w','/app',APP,'node','--input-type=module',input=script.encode()))
(OUT/'live-completion.json').write_text(json.dumps(state,indent=2))
cleanup={'dockerPs':docker('ps','--format','{{.Names}}\t{{.Status}}').decode(),
 'dockerPsA':docker('ps','-a','--format','{{.Names}}\t{{.Status}}').decode(),
 'testContainers':docker('ps','-a','--filter','label=com.mbbs.lifecycle=disposable-test','--format','{{.Names}}').decode().strip(),
 'taskContainers':docker('ps','-a','--filter','label=com.mbbs.task='+PROJECT,'--format','{{.Names}}').decode().strip(),
 'taskNetworks':docker('network','ls','--filter','label=com.docker.compose.project='+PROJECT,'--format','{{.Name}}').decode().strip(),
 'taskVolumes':docker('volume','ls','--filter','label=com.docker.compose.project='+PROJECT,'--format','{{.Name}}').decode().strip(),
 'production':{}}
for name in PRODUCTION:
 value=json.loads(docker('inspect','--format','{{json .State}}',name));health=value.get('Health',{}).get('Status','not configured')
 assert value['Running'] and health in ['healthy','not configured'],name
 cleanup['production'][name]={'running':True,'health':health}
(OUT/'cleanup-completion.json').write_text(json.dumps(cleanup,indent=2))
assert not any(cleanup[key] for key in ['testContainers','taskContainers','taskNetworks','taskVolumes'])
print(json.dumps({'completion':state,'cleanup':'complete','productionHealthy':True}))
