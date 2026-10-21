import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {fetchSalesOrderFulfillmentStateFromNetSuite} from '../../src/netsuite.js';
const id='f7d86119-7b12-4f1d-9ab7-2dc56ac5196a';
try {
 let blocker;
 try{await fetchSalesOrderFulfillmentStateFromNetSuite(990873);}catch(error){
  assert.ok(error.netsuiteErrorCodes?.includes('USER_ERROR')&&/locked by a user.defined workflow/i.test(error.message));
  blocker='NetSuite has 10 PC remaining on line 12 of SOA08709. Operator load 1170 and Driver drop-off are present, but a NetSuite workflow locks the source order and prevents exact verification. Resolve the NetSuite workflow lock before posting; no IF was sent.';
 }
 assert.ok(blocker,'Workflow lock must be independently rechecked');
 await withTransaction(async()=>{
  const row=(await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE id=$1 FOR UPDATE',[id])).rows[0];
  assert.equal(row.status,'attention');assert.equal(row.attempt_count,0);assert.equal(row.lease_token,null);
  assert.equal(row.dispatch_order_ref,'SOA08709');
  await query(`UPDATE dispatch_sales_order_if_candidates SET source_sales_order_id=990873,source_sales_order_ref='SOA08709',
    last_error=$2,updated_at=now() WHERE id=$1`,[id,blocker]);
  await query(`INSERT INTO dispatch_sales_order_if_audit_events(candidate_id,action,actor_id,reason,details)
    VALUES($1,'source_workflow_block_verified','maintenance:netsuite-attention-20261003',$2,$3::jsonb)`,[id,
    'User requested verification before retry; retain the genuine external blocker without posting.',
    JSON.stringify({previousError:row.last_error,error:blocker,sourceId:990873,existingIf:'IF154003',remaining:{orderLine:12,itemId:5056,quantity:10,unit:'PC'},
      operatorLoadRecordId:1170,driverCompletionEventId:17578,netSuitePostingAttempted:false})]);
 });
 console.log(JSON.stringify({reference:'SOA08709',status:'attention',error:blocker,netSuitePosts:0}));
}finally{await closeDb();}
