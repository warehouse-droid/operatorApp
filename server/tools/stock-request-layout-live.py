"""Read-only post-release and post-cleanup acceptance checks; no NetSuite calls."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import urllib.request

server=Path(__file__).resolve().parents[1]
out=server/'test-artifacts/stock-request-cleanup-layout'
receipt=json.loads((out/'private/deletion-receipt.json').read_text())
headers={'User-Agent':'Mozilla/5.0'}
served={}
for file in json.loads((out/'runtime-files.json').read_text()):
    if not file.startswith('public/'):continue
    path='/'+file.removeprefix('public/')
    if path=='/sales-stock-requests.html':path='/sales/stock-requests'
    if path=='/scm-stock-requests.html':path='/scm/stock-requests'
    with urllib.request.urlopen(urllib.request.Request('https://test.mbbsoperation.com'+path+'?v=20260927-yard-layout-v1',headers=headers),timeout=20) as response:
        assert response.status==200
        body=response.read()
        if file.endswith('.html'):
            # The edge proxy inserts its public analytics tag immediately before </body>.
            body=re.sub(rb'<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[^>]+></script>\n',b'',body)
        sha=hashlib.sha256(body).hexdigest()
        assert sha==hashlib.sha256((server/file).read_bytes()).hexdigest(),file
        served[file]=sha
parts=[]
for table in receipt['preserved']:
    where={'sales_orders':'netsuite_id IN (1017068,1017268)','sales_order_lines':'sales_order_id IN (1017068,1017268)','purchase_orders':'netsuite_id=1017168','purchase_order_lines':'purchase_order_id=1017168','sales_stock_transfer_lines':'true','sales_stock_transfer_reservations':'true'}.get(table)
    if where is None:where=('id' if table=='sales_stock_requests' else 'request_id')+' NOT IN (57,58,59,60,61,62,63,64)'
    parts.append("'"+table+"',jsonb_build_object('count',(SELECT count(*) FROM "+table+' WHERE '+where+"),'hash',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text) FROM "+table+' r WHERE '+where+'))')
sql="SELECT jsonb_build_object('preserved',jsonb_build_object("+','.join(parts)+"),'remainingSpecialRequests',(SELECT count(*) FROM sales_stock_requests WHERE request_type='special' OR request_ref LIKE 'SPREQ-%'))::text"
db=subprocess.run(['sudo','-n','docker','exec','mbbs-operator-app-db-1','psql','-U','mbbs_app','-d','mbbs_yard','-XAt','-v','ON_ERROR_STOP=1','-c',sql],capture_output=True,text=True,check=True)
result=json.loads(db.stdout)
assert result['preserved']==receipt['preserved']
assert result['remainingSpecialRequests']==0
code="""import assert from 'node:assert/strict';import {closeDb} from './src/db.js';import {listSpecialStockCases} from './src/special-stock-request-repository.js';
try {for(const options of [{audience:'scm'},{audience:'scm',storeLocationIds:'1,28'},{audience:'sales',authorizedStoreLocationIds:[1],storeLocationIds:'1,28'}])assert.deepEqual(await listSpecialStockCases(options),[]);console.log(JSON.stringify({queuesEmpty:true}));}finally{await closeDb();}"""
queues=subprocess.run(['sudo','-n','docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module','-'],input=code,capture_output=True,text=True,check=True)
assert json.loads(queues.stdout)['queuesEmpty']
result.update({'servedAssets':served,'queuesEmpty':True,'removedRequests':8,'netSuiteRequests':0})
(out/'live-acceptance.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'servedAssets':len(served),'queuesEmpty':True,'removedRequests':8,'regularRequestsPreserved':receipt['preserved']['sales_stock_requests']['count'],'linkedSOPreserved':2,'linkedPOPreserved':1,'netSuiteRequests':0}))
