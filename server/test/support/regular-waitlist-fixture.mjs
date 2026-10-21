import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query} from '../../src/db.js';
import {submitWaitlistRequest,createWaitlistPool,allocateWaitlistPool} from '../../src/regular-waitlist-repository.js';
export async function createWaitlistFixture(){
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  const actor='waitlist-'+randomUUID(),customerId=9144026001;let sequence=0;
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales','scm'],true)",[actor]);
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,display_name,legal_name,currency,active,source_modified_at,source_version,payload_hash) VALUES($1,'TEST-WAITLIST','TEST Waitlist Customer','TEST Waitlist Customer','CAD',true,now(),'test',repeat('a',64)) ON CONFLICT DO NOTHING",[customerId]);
  const context={operatorId:actor,authorizedDestinationLocationIds:[1,28]};
  async function supply(quantity=5000,prefix='UNI'){
    const number=++sequence,itemId=9244030000+number,poId=9244040000+number,poRef='PO-WAITLIST-EXTRA-'+number;
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_plt,to_pcs) VALUES($1,$2,'SQFT',100,2)",[itemId,prefix+'-EXTRA-'+number]);
    await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active,status_text,destination_location_id) VALUES($1,$2,true,'Pending Receipt',28)",[poId,poRef]);
    const line=(await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,quantity,unit,netsuite_active,location_id) VALUES($1,'1',$2,$3,$3,$4,'SQFT',true,28) RETURNING id",[poId,itemId,prefix+'-EXTRA-'+number,quantity])).rows[0];
    const demand=(qty=1000,yard=1)=>submitWaitlistRequest({deliveryMethod:'waitlist',customerId,destinationLocationId:yard,lines:[{itemId,salesQty:qty}],operationKey:randomUUID()},context);
    const pool=await createWaitlistPool({purchaseOrderRef:poRef,itemId,operationKey:randomUUID()},context);
    return {itemId,poId,poRef,lineId:Number(line.id),pool,demand};
  }
  const allocate=(pool,requests,reason='')=>allocateWaitlistPool(pool.id,{expectedRevision:pool.revision,operationKey:randomUUID(),overrideReason:reason,
    selections:requests.map(([request,quantity])=>({requestId:request.id,expectedRevision:request.revision,quantity}))},context);
  return {actor,customerId,context,supply,allocate};
}
