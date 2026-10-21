"""Verify eligibility of the named special request with SELECT-only candidate code."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

server = Path(__file__).resolve().parents[1]
source = (server / 'deployments/delivery-sales-updates-20261008/candidate/src/special-po-reference-alerts.js').read_text()
functions = []
for name in ['readAlerts','queuedSalesReferences']:
    match = re.search(r'^(?:export )?async function '+name+r'\(', source, re.M)
    assert match
    end = re.search(r'^}', source[match.start():], re.M)
    assert end
    functions.append(source[match.start():match.start()+end.end()].replace("import('./dispatch-repository.js')", "import('./src/dispatch-repository.js')"))
script = """import {query,withTransaction,closeDb} from './src/db.js';
import {createHash} from 'node:crypto';
import {specialPurchaseOrderDisplayRef} from './public/special-stock-po-reference.js';
const error=(message,status)=>Object.assign(Error(message),{status});
""" + '\n'.join(functions) + """
try {await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const {rows:[request]}=await query('SELECT id,requested_by,destination_location_id FROM sales_stock_requests WHERE request_ref=$1',['SPREQ-000043']);
  const notices=await readAlerts({audience:'sales',operatorId:request.requested_by,authorizedStoreLocationIds:[Number(request.destination_location_id)]},Number(request.id));
  console.log(JSON.stringify(notices.map(({requestRef,displayRef,audience,fulfillmentMethod})=>({requestRef,displayRef,audience,fulfillmentMethod})),null,2));
});}finally{await closeDb();}
"""
result = subprocess.run(['docker','exec','-i','mbbs-operator-app-app-1','node','--input-type=module'],input=script,text=True,capture_output=True,check=True,timeout=30)
notices=json.loads(result.stdout)
assert len(notices)==1 and notices[0]['displayRef']=='POB03993 / LOINC-037994' and notices[0]['audience']=='sales'
evidence={'readOnly':True,'sourceHash':hashlib.sha256(source.encode()).hexdigest(),'eligibleSalesNotices':notices}
(server/'test-artifacts/special-po-sales-alert-20261008/live-readonly-preview.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps(evidence,indent=2))
