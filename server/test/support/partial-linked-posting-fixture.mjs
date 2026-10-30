import crypto from 'node:crypto';
import {beginRollbackContext,query} from '../../src/db.js';
import {getOperatorNetSuitePostingPolicy} from '../../src/operator-netsuite-posting-policy-repository.js';
import * as p from '../../src/operator-netsuite-posting-repository.js';
import {createOperatorNetSuitePostingProcessor} from '../../src/operator-netsuite-posting-service.js';
import {createOperatorNetSuitePostingAdapter} from '../../src/operator-netsuite-posting-netsuite-adapter.js';
import {finalizeOperatorNetSuitePosting} from '../../src/operator-netsuite-posting-finalizer.js';
export async function rollback(work) {
  const context=await beginRollbackContext();
  try {return await context.run(work);} finally {await context.rollback();}
}
export async function seed(amount=40) {
  const id=9_951_000_000+crypto.randomInt(100_000_000), key=crypto.randomUUID();
  const f={id,so:`SO-PARTIAL-${key}`,po:`PO-PARTIAL-${key}`,pick:`PICK-${key}`,drop:`DROP-${key}`,load:`LOAD-${key}`,plan:id+2,amount};
  await query("UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key='operator_netsuite_receiving_ir_150'");
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,outbound_location_id,outbound_location,sales_order_type,netsuite_active)
    VALUES($1,$2,'B',26,'150','Delivery',true)`,[id,f.so]);
  f.sl=(await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,quantity,unit,location_id,location,netsuite_active)
    VALUES($1,101,1,2055,'MBBS-Special Order','MBBS-Special Order','NonInvtPart',100,'EACH',26,'150',true) RETURNING id`,[id])).rows[0].id;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,status,status_text,destination_location_id,destination_location,netsuite_active)
    VALUES($1,$2,$2,'B','Pending Receipt',26,'150',true)`,[id+1,f.po]);
  f.pl=(await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,quantity,unit,location_id,location,netsuite_active)
    VALUES($1,201,1,2055,'MBBS-Special Order','MBBS-Special Order','NonInvtPart',100,'EACH',26,'150',true) RETURNING id`,[id+1])).rows[0].id;
  f.pallet=(await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,quantity,unit,location_id,location,netsuite_active)
    VALUES($1,202,2,1784,'PALLET','PALLET','InvtPart',3,'EACH',26,'150',true) RETURNING id`,[id+1])).rows[0].id;
  f.allocation=(await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,allocated_sales_qty,status,dispatch_target_ref,dispatch_target_line_key,details)
    VALUES($1,$2,$3,$4,$5,$6,2055,'MBBS-Special Order','MBBS-Special Order',$7,'active',$2,$2||'::'||$2||'::'||$3::bigint::text,'{"poVendorYard":"Partial Vendor"}') RETURNING id`,[id,f.so,f.sl,id+1,f.po,f.pl,amount])).rows[0].id;
  await query(`INSERT INTO dispatch_plans(id,plan_date,status,revision) VALUES($1,date '2040-01-01'+($1::bigint%100000)::int,'confirmed',1)`,[f.plan]);
  await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
    VALUES($1,$2,current_date,$3,'partial-fixture','pickup',$4::jsonb,'complete',now(),'{"pickupLocation":"Partial Vendor"}')`,[f.pick,f.plan,f.load,JSON.stringify([f.so])]);
  return f;
}
export async function deliver(f) {
  return (await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
    VALUES($1,$2,current_date,$3,'partial-fixture','dropoff',$4::jsonb,'complete',now(),$5::jsonb) RETURNING id`,
  [f.drop,f.plan,f.load,JSON.stringify([f.so]),JSON.stringify({orders:[{orderType:'SO',orderRef:f.so}],location:'Customer'})])).rows[0].id;
}
export function source(f,received=0) {
  return {sourceOrderKind:'PO',sourceNetSuiteId:f.id+1,sourceOrderRef:f.po,status:'B',lines:[
    {sourceLineKey:'201',restOrderLine:1,itemId:2055,itemName:'MBBS-Special Order',identityStatus:'exact',unit:'EACH',quantity:100,orderedQuantity:100,completedQuantity:received,remainingQuantity:100-received,location:26,linkedTransactions:[]},
    {sourceLineKey:'202',restOrderLine:2,itemId:1784,itemName:'PALLET',identityStatus:'exact',unit:'EACH',quantity:3,orderedQuantity:3,completedQuantity:0,remainingQuantity:3,location:26,linkedTransactions:[]}
  ]};
}
export const dependencies=f=>({fetchSource:async()=>source(f),getPolicy:input=>getOperatorNetSuitePostingPolicy({...input,directAccessEnabled:true})});

export function processor(f,{received=0}={}) {
  let transforms=0,remote=null;
  const adapter=createOperatorNetSuitePostingAdapter({findTransactionByExternalId:async()=>remote,
    transformSalesOrderToItemFulfillment:async()=>{throw new Error('Unexpected SO transform');},
    transformTransferOrderToItemFulfillment:async()=>{throw new Error('Unexpected TO transform');},
    transformTransferOrderToItemReceipt:async()=>{throw new Error('Unexpected TO receipt');},
    fetchDirectReceiptSource:async()=>({status:'B',lines:[{restLineId:1,itemId:2055,quantity:100,receivedQuantity:received,locationId:26},{restLineId:2,itemId:1784,quantity:3,receivedQuantity:0,locationId:26}]}),
    transformPurchaseOrderToItemReceipt:async(id,payload)=>{
      transforms++;remote={id:f.id+5+received,tranId:`IR-PARTIAL-${received}`,transactionType:'IR',createdFromId:id,externalId:payload.externalId,
        item:{items:payload.item.items.filter(item=>item.itemReceive).map(item=>({...item,item:{id:item.orderLine===1?2055:1784},units:{refName:'EACH'}}))}};
      return {id:remote.id};
    },fetchItemFulfillment:async()=>null,fetchItemReceipt:async()=>remote});
  const runtime=createOperatorNetSuitePostingProcessor({workerId:'partial-posting-test',adapter,finalize:finalizeOperatorNetSuitePosting,
    repository:{get:p.getOperatorNetSuitePostingCommand,claim:p.claimOperatorNetSuitePostingCommand,renew:p.renewOperatorNetSuitePostingLease,
      startAttempt:p.startOperatorNetSuitePostingAttempt,success:p.recordOperatorNetSuitePostingStepSuccess,failure:p.recordOperatorNetSuitePostingStepFailure,
      attention:p.markOperatorNetSuitePostingCommandAttention,fail:p.failOperatorNetSuitePostingCommand,complete:p.completeOperatorNetSuitePostingCommand}});
  return {runtime,transforms:()=>transforms};
}
