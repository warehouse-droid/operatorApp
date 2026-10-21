import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, {after} from 'node:test';
import {beginRollbackContext,closeDb,query,withTransaction} from '../../../src/db.js';
import {prepareSalesOrderAutoFulfillmentCandidate} from '../../../src/sales-order-auto-fulfillment-repository.js';
import {getOperatorNetSuitePostingPolicy} from '../../../src/operator-netsuite-posting-policy-repository.js';
import {createOrReplayOperatorNetSuitePostingCommand} from '../../../src/operator-netsuite-posting-repository.js';
import {buildOperatorNetSuitePostingDraft} from '../../../src/operator-netsuite-posting-domain.js';
after(closeDb);
async function rollback(work){const context=await beginRollbackContext();try{return await context.run(work);}finally{await context.rollback();}}

async function seed(){
  const id=9_876_000_000+Math.floor(Math.random()*100000),key=crypto.randomUUID(),so=`SO-DIRECT-${key}`,po=`PO-DIRECT-${key}`;
  for(const flag of ['dispatch_netsuite_sales_order_if_150','operator_netsuite_receiving_ir_150'])await query('UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key=$1',[flag]);
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,outbound_location_id,outbound_location,sales_order_type,netsuite_active)
    VALUES($1,$2,'B',26,'150','Delivery',true)`,[id,so]);
  const sl=(await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,quantity,location_id,location,loaded_qty,netsuite_active)
    VALUES($1,5004139,1,2055,'MBBS-Special Order','MBBS-Special Order','NonInvtPart',270.78,26,'150',0,true) RETURNING id`,[id])).rows[0].id;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,status,status_text,destination_location_id,destination_location,netsuite_active)
    VALUES($1,$2,$2,'B','Pending Receipt',26,'150',true)`,[id+1,po]);
  const pl=(await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,quantity,location_id,location,netsuite_active)
    VALUES($1,5004774,1,2055,'MBBS-Special Order','MBBS-Special Order','NonInvtPart',270.78,26,'150',true) RETURNING id`,[id+1])).rows[0].id;
  await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,allocated_sales_qty,status,dispatch_target_ref,dispatch_target_line_key,details)
    VALUES($1,$2,$3,$4,$5,$6,2055,'MBBS-Special Order','MBBS-Special Order',270.78,'active',$2,$2||'::'||$2||'::'||$3::bigint::text,'{"poVendorYard":"DIRECT TEST Vendor"}')`,[id,so,sl,id+1,po,pl]);
  const plan=id+2,load=`LOAD-${key}`,pick=`PICK-${key}`,drop=`DROP-${key}`;
  await query(`INSERT INTO dispatch_plans(id,plan_date,status,revision) VALUES($1,current_date,'confirmed',1)`,[plan]);
  await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
    VALUES($1,$2,current_date,$3,'direct-ship-test','pickup',$4::jsonb,'complete',now(),'{"pickupLocation":"DIRECT TEST Vendor","location":"DIRECT TEST Vendor"}')`,[pick,plan,load,JSON.stringify([po,so])]);
  return {id,so,po,pl,plan,load,pick,drop};
}
async function deliver(f){await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
  VALUES($1,$2,current_date,$3,'direct-ship-test','dropoff',$4::jsonb,'complete',now(),$5::jsonb)`,[f.drop,f.plan,f.load,JSON.stringify([f.so]),JSON.stringify({orders:[{orderType:'SO',orderRef:f.so}],location:'Customer destination'})]);}
function source(f){return {sourceOrderKind:'PO',sourceNetSuiteId:f.id+1,sourceOrderRef:f.po,status:'B',statusText:'Pending Receipt',lines:[
  {sourceLineKey:'5004774',restOrderLine:1,itemId:2055,itemName:'MBBS-Special Order',itemType:'NonInvtPart',identityStatus:'exact',quantity:270.78,orderedQuantity:270.78,completedQuantity:0,remainingQuantity:270.78,location:26,linkedTransactions:[]}]};}
const dependencies=f=>({fetchSource:async()=>source(f),getPolicy:input=>getOperatorNetSuitePostingPolicy({...input,directAccessEnabled:true})});

test('fully direct special SO materializes its 270.78 delivered quantity with exact pickup/drop evidence',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const candidate=(await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=$1',[f.so])).rows[0];
  const prepared=await prepareSalesOrderAutoFulfillmentCandidate(candidate.id);
  assert.equal(prepared.status,'queued');assert.equal(prepared.lineSnapshot.length,1);
  assert.equal(prepared.lineSnapshot[0].deliveredQuantity,270.78);assert.equal(prepared.lineSnapshot[0].operatorLoadedQuantity,0);
  assert.equal(prepared.lineSnapshot[0].poEvidence[0].pickupJobId,f.pick);assert.equal(prepared.lineSnapshot[0].poEvidence[0].deliveryJobId,f.drop);
}));

