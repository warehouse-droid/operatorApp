"""Compare old and candidate search SQL within one live read-only snapshot."""
import json
from pathlib import Path
import subprocess

server = Path(__file__).resolve().parents[1]
source = (server / 'src/dispatch-order-pool-sql.js').read_text().replace(
    '"./netsuite-closed-order-policy.js"', '"file:///app/src/netsuite-closed-order-policy.js"')
script = r'''
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pool,query,withTransaction,closeDb} from './src/db.js';
import {netSuiteClosedOrderFamilySql} from './src/netsuite-closed-order-policy.js';
pool.options.options=(pool.options.options||'')+' -c default_transaction_read_only=on -c statement_timeout=45000 -c application_name=dispatch_tob_semantic_parity';
const {DISPATCH_CLOSED_ORDER_FAMILY_CTES}=await import('data:text/javascript;base64,'+Buffer.from(SOURCE).toString('base64'));
let candidate=false;
pool.on('connect',client=>{
 const original=client.query.bind(client);
 client.query=function(...args){
  let sql=typeof args[0]==='string'?args[0]:'';
  if(candidate&&sql.includes('WITH requested_exact_refs')) {
   sql=sql.replace('WITH requested_exact_refs','WITH '+DISPATCH_CLOSED_ORDER_FAMILY_CTES+', requested_exact_refs');
   assert.ok(sql.includes('receiving_line_source AS ('));
   sql=sql.replace('receiving_line_source AS (','receiving_line_source AS MATERIALIZED (');
   for(const [kind,table] of [['so','sales_orders'],['po','purchase_orders'],['to','transfer_orders']]) {
    const previous=netSuiteClosedOrderFamilySql(table,kind.toUpperCase());assert.ok(sql.includes(previous));
    sql=sql.replaceAll(previous,`${table}.netsuite_id IN (SELECT id FROM closed_${kind}_ids)`);
   }
   args[0]=sql;
  }
  return original(...args);
 };
});
try {
 const {loadDispatchOrdersForResponse}=await import('./src/server.js');
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const options={search:'TOB0126',includeCompletedScmSearch:true};
  const baseline=await loadDispatchOrdersForResponse(options);
  candidate=true;
  const after=await loadDispatchOrdersForResponse(options);
  assert.deepEqual(after,baseline,'Full returned order data changed');
  assert.deepEqual(after.map(o=>o.id).sort(),Array.from({length:10},(_,i)=>'TOB0126'+i));
  return {at:new Date().toISOString(),identical:true,count:after.length,
   refs:after.map(o=>o.id).sort(),sha256:createHash('sha256').update(JSON.stringify(after)).digest('hex'),
   transaction:'repeatable read, read only',note:'Serialized parity comparison; elapsed time is not an HTTP benchmark'};
 });
 console.log(JSON.stringify(result));
} finally {await closeDb();}
'''.replace('SOURCE', json.dumps(source))
result = subprocess.check_output(['sudo', '-n', 'docker', 'exec', '-i', 'mbbs-operator-app-app-1',
    'node', '--input-type=module'], input=script.encode(), timeout=180)
proof = json.loads(result)
release = server / 'deployments/dispatch-tob-search-20261028'
release.mkdir(parents=True, exist_ok=True)
(release / 'live-parity.json').write_text(json.dumps(proof, indent=2) + '\n')
print(json.dumps(proof))
