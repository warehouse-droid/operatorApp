import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test,{after} from 'node:test';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {buildOperatorNetSuitePostingDraft} from '../../../src/operator-netsuite-posting-domain.js';
import * as repository from '../../../src/operator-netsuite-posting-repository.js';
import {reconcileSob120541} from '../../../tools/sob120541-repair.mjs';
after(closeDb);
const id=995451,requestId='8574bd86-a8fb-48ee-aba5-042d85734d4f';
const sourceLines=[
 {line_id:4967884,netsuite_order_line:1,item_id:1354,quantity:156.75,pallet_qty:1,layer_qty:3,to_plt:125.4,to_lyr:10.45},
 {line_id:4967885,netsuite_order_line:2,item_id:1501,quantity:24.6,layer_qty:2,to_lyr:12.3},
 {line_id:4967886,netsuite_order_line:3,item_id:1784,quantity:2,item_name:'PALLET'},
 {line_id:4967891,netsuite_order_line:8,item_id:602,quantity:2,piece_qty:2,to_pcs:1,to_plt:70,item_name:'Alliance G2 Supersand Beige'}
].map(line=>({location_id:1,location:'3445',unit:'PC',item_type:'InvtPart',item_name:`ITEM-${line.item_id}`,netsuite_received_qty:line.quantity,...line}));
const record={id:996410,tranId:'IF153890',externalId:`MBBS-OP-${requestId}-1`,createdFrom:{id},item:{items:sourceLines.map(line=>({orderLine:line.netsuite_order_line,item:{id:line.item_id},quantity:line.quantity,itemReceive:true,location:{id:1}}))}};
async function fixture(run){return withTransaction(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 const operator=await createOperator({username:`repair-${crypto.randomUUID()}`,displayName:'Repair test',password:'repair-test-password',role:'operator',roles:['operator'],yardLocationIds:[1]});
 await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,sales_order_type,outbound_location_id,outbound_location,operator_status,netsuite_active) VALUES($1,'SOB120541','B','Pending Fulfillment','Pick-Up',1,'3445','open',true)",[id]);
 const selected=[];
 for(const line of sourceLines.slice(0,3)){
  const row=(await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,quantity,unit,location_id,location,pallet_qty,layer_qty,to_plt,to_lyr,packed_pallet_qty,packed_layer_qty,packed_sales_qty,netsuite_active)
   VALUES($1,$2,$3,$4,$5,$5,'InvtPart',$6,'PC',1,'3445',$7,$8,$9,$10,$7,$8,$11,true) RETURNING id`,[id,line.line_id,line.netsuite_order_line,line.item_id,line.item_name,line.quantity,line.pallet_qty||0,line.layer_qty||0,line.to_plt||0,line.to_lyr||0,line.netsuite_order_line===3?2:0])).rows[0];
  selected.push({orderLine:line.netsuite_order_line,quantity:line.quantity,location:1,localLineId:String(row.id),localOrderKey:`customer_pickup:sales_order:${id}`});
 }
 const draft=buildOperatorNetSuitePostingDraft({requestId,actorOperatorId:operator.id,functionKey:'customer_pickup',transactionType:'IF',photoRefs:['r2://repair/test.jpg'],
  policy:{gateKey:'operator_netsuite_customer_pickup_if_3445',revision:1,effective:true,functionKey:'customer_pickup',transactionType:'IF',locationId:1,yardCode:'3445'},localOrderKeys:[`customer_pickup:sales_order:${id}`],localOperation:{kind:'customer_pickup_load',orderId:String(id),orderType:'sales_order'},
  targets:[{sourceOrderKind:'SO',sourceNetSuiteId:id,sourceOrderRef:'SOB120541',selectedLines:selected,availableLines:selected}]});
 const {command}=await repository.createOrReplayOperatorNetSuitePostingCommand(draft);
 const lease=await repository.claimOperatorNetSuitePostingCommand({commandId:requestId,workerId:'repair-test'});
 const attempt=await repository.startOperatorNetSuitePostingAttempt({commandId:requestId,stepId:command.steps[0].id,leaseToken:lease.leaseToken});
 await repository.recordOperatorNetSuitePostingStepFailure({commandId:requestId,stepId:command.steps[0].id,leaseToken:lease.leaseToken,attemptNumber:attempt.attemptNumber,error:new Error('Extra line'),uncertain:true});
 await repository.markOperatorNetSuitePostingCommandAttention({commandId:requestId,leaseToken:lease.leaseToken,error:new Error('Extra line')});
 return run(await repository.getOperatorNetSuitePostingCommand(requestId));
},{rollback:true});}
test('SOB120541 repair dry run rolls back; apply records four lines and a repeated apply is a no-op',()=>fixture(async before=>{
 const dry=await reconcileSob120541({record,sourceLines},{apply:false});assert.equal(dry.completed,true);
 assert.equal((await repository.getOperatorNetSuitePostingCommand(requestId)).status,'attention');
 assert.equal((await query('SELECT count(*)::int n FROM sales_order_lines WHERE sales_order_id=$1',[id])).rows[0].n,3);
 const result=await reconcileSob120541({record,sourceLines},{apply:true});assert.equal(result.completed,true);
 const after=await repository.getOperatorNetSuitePostingCommand(requestId);
 assert.equal(after.status,'completed');assert.equal(after.steps[0].netSuiteTransactionId,996410);assert.equal(after.activeClaims.length,0);
 assert.equal(after.inputHash,before.inputHash);assert.deepEqual(after.inputSnapshot,before.inputSnapshot);assert.deepEqual(after.steps[0].payload,before.steps[0].payload);
 const loaded=(await query('SELECT line_id,loaded_qty,confirmed,packed_sales_qty FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY line_id',[id])).rows;
 assert.deepEqual(loaded.map(line=>Number(line.loaded_qty)),[156.75,24.6,2,2]);assert.ok(loaded.every(line=>!line.confirmed&&Number(line.packed_sales_qty)===0));
 assert.equal((await query('SELECT line_snapshot FROM operator_load_records WHERE order_id=$1',[id])).rows[0].line_snapshot.length,4);
 assert.equal((await reconcileSob120541({record,sourceLines},{apply:true})).alreadyCompleted,true);
 assert.equal((await query('SELECT count(*)::int n FROM operator_load_records WHERE order_id=$1',[id])).rows[0].n,1);
}));
test('repair refuses wrong item, quantity, source or external ID without changing local state',()=>fixture(async before=>{
 for(const kind of ['item','quantity','source','external']){
  const changed=structuredClone(record);
  if(kind==='item')changed.item.items[3].item.id=999;
  if(kind==='quantity')changed.item.items[3].quantity=3;
  if(kind==='source')changed.createdFrom.id=1;
  if(kind==='external')changed.externalId='wrong';
  await assert.rejects(reconcileSob120541({record:changed,sourceLines},{apply:true}));
  assert.deepEqual(await repository.getOperatorNetSuitePostingCommand(requestId),before);
 }
}));
