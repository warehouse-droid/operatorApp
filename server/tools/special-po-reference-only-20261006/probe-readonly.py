"""Exercise the candidate reader against live records without editing live source."""
import base64
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
candidate = base64.b64encode((root / 'src/special-stock-native-po-adapter.js').read_bytes()).decode()
script = """
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getSpecialStockCase} from './src/special-stock-request-repository.js';
import {closeDb} from './src/db.js';
// Expose the deployed REST reader only in this short-lived diagnostic module.
// Relative imports still resolve to deployed code; no live file is changed.
const source=readFileSync('./src/netsuite.js','utf8').replace(/(['"])(\\.{1,2}\\/[^'"]+)\\1/g,
  (_match,quote,path)=>quote+new URL(path,'file:///app/src/netsuite.js').href+quote)+'\\nexport {netsuiteRest};';
const ns=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const adapter=await import('data:text/javascript;base64,CANDIDATE');
try{
  const d=await getSpecialStockCase(119,{audience:'scm',dispatchPlans:[]});
  const location=(await ns.resolveNetSuiteYardLocations([{locationId:d.operationalYardLocationId,code:d.storeName}]))[0];
  let reads=0;
  const found=await adapter.findLinkedSpecialPurchaseOrder({independent:true,salesOrderId:d.salesOrderId,salesOrderLines:[],
    purchaseOrderLines:[{caseLineId:69}],payload:{entity:{id:String(d.vendorId)},location:{id:String(location.netsuiteLocationId)},
      memo:'MBBS-SPECIAL-PO:'+d.id,item:{items:[{item:{id:'2055'},quantity:697.44,units:'873',rate:0,description:'Read-only verification'}]}}},
    {rest:async(path,options={})=>{assert.ok(!options.method||options.method==='GET');reads++;return ns.netsuiteRest(path,options);},
      queryAll:async()=>{throw Error('Independent linkage must not need an item mapping query');}});
  assert.equal(found?.id,1043746);assert.equal(found?.tranid,'POB04004');
  console.log(JSON.stringify({request:d.requestRef,existingPurchaseOrder:found.tranid,purchaseOrderId:found.id,readOnly:true,reads}));
}finally{await closeDb();}
""".replace('CANDIDATE', candidate)
result = json.loads(subprocess.check_output(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1',
                                            'node','--input-type=module'], input=script.encode()))
(root / 'test-artifacts/special-po-reference-only-20261006/candidate-live-readonly.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
