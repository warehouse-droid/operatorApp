"""Read-only completion and disposal checks for the PO and shared scrolling repair."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-artifacts/special-po-000041'
PRIVATE=Path('/home/ubuntu/operatorapp-investigations/special-po-000041/private')
APP='mbbs-operator-app-app-1'
PROJECT='mbbs-special-po-000041'
PRODUCTION=[APP,'mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1']

def docker(*args,**kwargs):return subprocess.check_output(['docker',*args],**kwargs)

subprocess.run(['python3',str(ROOT/'tools/special-po-000041/deploy.py'),'verify'],check=True)
script="""import assert from 'node:assert/strict';import {query,withTransaction,closeDb} from './src/db.js';
import {getSpecialStockCase} from './src/special-stock-request-repository.js';
import {specialOrderSnapshot} from './src/special-stock-documents.js';
try{const value=await withTransaction(async()=>{
 await query('SET TRANSACTION READ ONLY');const d=await getSpecialStockCase(125,{audience:'scm',dispatchPlans:[]});
 assert.equal(d.requestRef,'SPREQ-000041');assert.equal(d.purchaseOrderId,1042761);assert.equal(d.purchaseOrderRef,'POB03999');
 assert.equal(d.salesOrderId,1042205);assert.equal(d.salesOrderRef,'SOB122143');assert.equal(d.purchaseOrderOperationStatus,'linked');
 assert.equal(d.purchaseOrderOperationError,'');assert.equal(d.attention,false);assert.equal(d.purchaseOrderCustomLinkage,true);
 assert.equal(specialOrderSnapshot(d,'purchase_order','scm').id,1042761);
 const sales=await getSpecialStockCase(125,{audience:'sales',authorizedStoreLocationIds:[1],dispatchPlans:[]});
 assert.equal(specialOrderSnapshot(sales,'sales_order','sales').id,1042205);
 const prior=await getSpecialStockCase(106,{audience:'sales',authorizedStoreLocationIds:[1],dispatchPlans:[]});
 assert.equal(prior.salesOrderId,1041956);assert.equal(prior.salesOrderRef,'SOB122131');
 const audits=await query("SELECT count(*)::int AS count FROM sales_special_stock_events WHERE request_id=125 AND event_type='special_purchase_order_existing_reference_recovery'");
 assert.equal(audits.rows[0].count,1);
 return {requestRef:d.requestRef,revision:d.revision,purchaseOrderRef:d.purchaseOrderRef,salesOrderRef:d.salesOrderRef,
  operationStatus:d.purchaseOrderOperationStatus,attention:d.attention,poPreviewAvailable:true,soPreviewAvailable:true,
  priorSoLinkPreserved:true,recoveryAuditCount:audits.rows[0].count,applicationWrites:0};
});console.log(JSON.stringify(value));}finally{await closeDb();}"""
state=json.loads(docker('exec','-i','-w','/app',APP,'node','--input-type=module',input=script.encode()))
pdf=(PRIVATE/'POB03999.pdf').read_bytes()
recovery=json.loads((OUT/'recovery-apply.log').read_text())
assert pdf.startswith(b'%PDF-') and len(pdf)==recovery['preview']['bytes']
assert hashlib.sha256(pdf).hexdigest()==recovery['preview']['sha256']
state['actualPdf']=recovery['preview'];(OUT/'live-completion.json').write_text(json.dumps(state,indent=2))
cleanup={
 'dockerPs':docker('ps','--format','{{.Names}}\t{{.Status}}').decode(),
 'dockerPsA':docker('ps','-a','--format','{{.Names}}\t{{.Status}}').decode(),
 'testContainers':docker('ps','-a','--filter','label=com.mbbs.lifecycle=disposable-test','--format','{{.Names}}').decode().strip(),
 'taskContainers':docker('ps','-a','--filter','label=com.mbbs.task='+PROJECT,'--format','{{.Names}}').decode().strip(),
 'taskNetworks':docker('network','ls','--filter','label=com.docker.compose.project='+PROJECT,'--format','{{.Name}}').decode().strip(),
 'taskVolumes':docker('volume','ls','--filter','label=com.docker.compose.project='+PROJECT,'--format','{{.Name}}').decode().strip(),
 'production':{},
}
for name in PRODUCTION:
 value=json.loads(docker('inspect','--format','{{json .State}}',name));health=value.get('Health',{}).get('Status','not configured')
 assert value['Running'] and health in ['healthy','not configured'],name
 cleanup['production'][name]={'running':True,'health':health}
(OUT/'cleanup-completion.json').write_text(json.dumps(cleanup,indent=2))
assert not any(cleanup[key] for key in ['testContainers','taskContainers','taskNetworks','taskVolumes'])
print(json.dumps({'completion':state,'cleanup':'complete','productionHealthy':True}))
